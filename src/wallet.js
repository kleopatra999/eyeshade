var bitcoinjs = require('bitcoinjs-lib')
var braveHapi = require('./brave-hapi')
var crypto = require('crypto')
var currencyCodes = require('currency-codes')
var debug = new (require('sdebug'))('wallet')
var Joi = require('joi')
var underscore = require('underscore')

var onceonlyP

var Wallet = function (config, runtime) {
  if (!(this instanceof Wallet)) return new Wallet(config)

  if (!config.wallet) throw new Error('config.wallet undefined')

  if (!config.wallet.bitgo) config.wallet = { bitgo: config.wallet }
  this.config = config.wallet
  this.config.environment = config.wallet.bitgo.environment
  this.runtime = runtime
  this.bitgo = new (require('bitgo')).BitGo({
    accessToken: config.wallet.bitgo.accessToken,
    env: config.wallet.bitgo.environment || 'prod'
  })
  debug('environment: ' + this.config.environment)

  if (!onceonlyP) {
    onceonlyP = true

    maintenance(this.config, this.runtime)
    setInterval(function () { maintenance(this.config, this.runtime) }.bind(this), 15 * 60 * 1000)
  }
}

Wallet.prototype.create = async function (prefix, label, keychains) {
  var result
  var xpubs = []

  xpubs[0] = underscore.pick(await this.bitgo.keychains().add(underscore.extend({ label: 'user' }, keychains.user)), [ 'xpub' ])
  xpubs[1] = underscore.pick(await this.bitgo.keychains().add({
    label: 'unspendable',
    xpub: this.config.bitgo.unspendableXpub
  }), [ 'xpub' ])
  xpubs[2] = underscore.pick(await this.bitgo.keychains().createBitGo({}), [ 'xpub' ])

  result = await this.bitgo.wallets().add({
    label: label,
    m: 2,
    n: 3,
    keychains: xpubs,
    enterprise: this.config.bitgo.enterpriseId,
    disableTransactionNotifications: true
  })
  result.wallet.provider = 'bitgo'

  result.addWebhook({ url: prefix + '/callbacks/bitgo/sink', type: 'transaction', numConfirmations: 1 }, function (err) {
    if (err) debug('wallet addWebhook', { label: label, message: err.toString() })

    result.setPolicyRule({
      id: 'com.brave.limit.velocity.30d',
      type: 'velocityLimit',
      condition: {
        type: 'velocity',
        amount: 7000000,
        timeWindow: 30 * 86400,
        groupTags: [],
        excludeTags: []
      },
      action: { type: 'deny' }
    }, function (err) {
      if (err) debug('wallet setPolicyRule com.brave.limit.velocity.30d', { label: label, message: err.toString() })
    })
  })

  return result
}

Wallet.prototype.balances = async function (info) {
  var f = Wallet.providers[info.provider].balances

  if (!f) throw new Error('provider ' + info.provider + ' balances not supported')
  return f.bind(this)(info)
}

Wallet.prototype.purchaseBTC = function (info, amount, currency) {
  var f = Wallet.providers[info.provider].purchaseBTC

  if (!f) f = Wallet.providers.coinbase.purchaseBTC
  if (!f) return {}
  return f.bind(this)(info, amount, currency)
}

Wallet.prototype.recurringBTC = function (info, amount, currency) {
  var f = Wallet.providers[info.provider].recurringBTC

  if (!f) f = Wallet.providers.coinbase.recurringBTC
  if (!f) return {}
  return f.bind(this)(info, amount, currency)
}

Wallet.prototype.transferP = function (info) {
  var f = Wallet.providers[info.provider].transferP

  return ((!!f) && (f.bind(this)(info)))
}

Wallet.prototype.transfer = async function (info, satoshis) {
  var f = Wallet.providers[info.provider].transfer

  if (!f) throw new Error('provider ' + info.provider + ' transfer not supported')
  return f.bind(this)(info, satoshis)
}

Wallet.prototype.compareTx = function (unsignedHex, signedHex) {
  var i
  var signedTx = bitcoinjs.Transaction.fromHex(signedHex)
  var unsignedTx = bitcoinjs.Transaction.fromHex(unsignedHex)

  if ((unsignedTx.version !== signedTx.version) || (unsignedTx.locktime !== signedTx.locktime)) return false

  if (unsignedTx.ins.length !== signedTx.ins.length) return false
  for (i = 0; i < unsignedTx.ins.length; i++) {
    if (!underscore.isEqual(underscore.omit(unsignedTx.ins[i], 'script'), underscore.omit(signedTx.ins[i], 'script'))) {
      return false
    }
  }

  return underscore.isEqual(unsignedTx.outs, signedTx.outs)
}

Wallet.prototype.submitTx = async function (info, signedTx) {
  var f = Wallet.providers[info.provider].submitTx

  if (!f) throw new Error('provider ' + info.provider + ' submitTx not supported')
  return f.bind(this)(info, signedTx)
}

Wallet.prototype.unsignedTx = async function (info, amount, currency, balance) {
  var f = Wallet.providers[info.provider].unsignedTx

  if (!f) throw new Error('provider ' + info.provider + ' unsignedTx not supported')
  return f.bind(this)(info, amount, currency, balance)
}

Wallet.prototype.rates = {}

var schema1 = Joi.object({}).pattern(/timestamp|[A-Z][A-Z][A-Z]/,
                                     Joi.alternatives().try(Joi.date(),
                                                            Joi.object().keys({ last: Joi.number().positive() }).unknown(true)))
                 .required()
var schema2 = Joi.object()
              .keys({
                bpi: Joi.object().pattern(/[A-Z][A-Z][A-Z]/,
                                          Joi.object().keys({
                                            code: Joi.string().regex(/[A-Z][A-Z][A-Z]/).required(),
                                            rate_float: Joi.number().positive().required()
                                          }).unknown(true)).required()

              }).unknown(true)

var maintenance = async (config, runtime) => {
  var rates, result1, result2
  var timestamp = Math.round(underscore.now() / 1000)
  var prefix = timestamp + '.' + config.bitcoin_average.publicKey
  var suffix = crypto.createHmac('sha256', config.bitcoin_average.secretKey).update(prefix).digest('hex')
  var signature = prefix + '.' + suffix

  var fetch = async (url, props, schema) => {
    var result, validity

    result = await braveHapi.wreck.get(url, props)
    if (Buffer.isBuffer(result)) result = result.toString()
// courtesy of https://stackoverflow.com/questions/822452/strip-html-from-text-javascript#822464
    if (result.indexOf('<html>') !== -1) throw new Error(result.replace(/<(?:.|\n)*?>/gm, ''))

    result = JSON.parse(result)
    validity = Joi.validate(result, schema)
    if (validity.error) throw new Error(validity.error)

    return result
  }

  try {
    result1 = await fetch('https://apiv2.bitcoinaverage.com/indices/global/ticker/all?crypto=BTC',
                          { headers: { 'x-signature': signature } }, schema1)
  } catch (ex) {
    return runtime.notify(debug, { text: 'maintenance error(1): ' + ex.toString() })
  }

  try {
    result2 = await fetch('http://api.coindesk.com/v1/bpi/currentprice.json', {}, schema2)
  } catch (ex) {
    return runtime.notify(debug, { text: 'maintenance error(2): ' + ex.toString() })
  }

  rates = {}
  underscore.keys(result1).forEach(currency => {
    var rate = result1[currency]

    if ((currency.indexOf('BTC') !== 0) || (typeof rate !== 'object') || (!rate.last)) return

    rates[currency.substr(3)] = rate.last
  })
  if ((!rates.USD) || (!rates.EUR) || (!rates.GBP)) {
    return runtime.notify(debug, { text: 'maintenance error(3): currencies available ' + underscore.keys(rates) })
  }
  if ((!result2.bpi.USD) || (!result2.bpi.EUR) || (!result2.bpi.GBP)) {
    return runtime.notify(debug, { text: 'maintenance error(4): currencies available ' + underscore.keys(result2.bpi) })
  }

  var compar = (currency) => {
    var ratio = rates[currency] / result2.bpi[currency].rate_float

    if ((ratio < 0.9) || (ratio > 1.1)) {
      throw new Error('maintenance error(5): ' + currency + ' ' + rates[currency] + ' vs. ' + result2.bpi[currency].rate_float)
    }
  }

  try {
    compar('USD')
    compar('EUR')
    compar('GBP')
  } catch (ex) {
    return runtime.notify(debug, { text: ex.toString() })
  }

  Wallet.prototype.rates = rates
  debug('BTC key rates', underscore.pick(rates, [ 'USD', 'EUR', 'GBP' ]))
}

module.exports = Wallet

Wallet.providers = {}

Wallet.providers.bitgo = {
  balances: async (info) => {
    var wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })

    return {
      balance: wallet.balance(),
      spendable: wallet.spendableBalance(),
      confirmed: wallet.confirmedBalance(),
      unconfirmed: wallet.unconfirmedReceives()
    }
  },

  submitTx: async (info, signedTx) => {
    var details, i, result
    var wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })

    result = await wallet.sendTransaction({ tx: signedTx })

// courtesy of https://stackoverflow.com/questions/33289726/combination-of-async-function-await-settimeout#33292942
    var timeout = (msec) => { return new Promise((resolve) => { setTimeout(resolve, msec) }) }

    for (i = 0; i < 5; i++) {
      try {
        details = await this.bitgo.blockchain().getTransaction({ id: result.hash })
        break
      } catch (ex) {
        debug('getTransaction', ex)
        await timeout(1 * 1000)
        debug('getTransaction', { retry: i + 1, max: 5 })
      }
    }
    underscore.extend(result, { fee: details.fee })

    for (i = details.outputs.length - 1; i >= 0; i--) {
      if (details.outputs[i].account !== this.config.bitgo.settlementAddress) continue

      underscore.extend(result, { address: details.outputs[i].account, satoshis: details.outputs[i].value })
      break
    }

    return result
  },

  transferP: (info) => {
    return ((!!this.config.bitgo.fundingAddress) && (!!this.config.bitgo.fundingPassphrase))
  },

  transfer: async (info, satoshis) => {
    var balance, currencies, remaining, result, wallet

    if (!this.config.bitgo.fundingAddress) throw new Error('no funding address configured')
    if (!this.config.bitgo.fundingPassphrase) throw new Error('no funding passphrase configured')

    wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: this.config.bitgo.fundingAddress })
    try {
      result = await wallet.sendCoins({
        address: info.address,
        amount: satoshis,
        walletPassphrase: this.config.bitgo.fundingPassphrase
      })

      balance = wallet.confirmedBalance()
      try {
        balance = JSON.parse(JSON.stringify(wallet)).spendableConfirmedBalance
      } catch (ex) { }
      currencies = [ 'USD', 'EUR', 'GBP' ]
      remaining = {}
      currencies.forEach((fiat) => {
        var currency = currencyCodes.code(fiat)

        if (!Wallet.prototype.rates[fiat]) return

        remaining[fiat] = ((balance * Wallet.prototype.rates[fiat]) / 1e8).toFixed(currency ? currency.digits : 2)
      })

      return underscore.extend(result, { remaining: remaining })
    } catch (ex) {
      throw new Error(ex.toString())
    }
  },

  unsignedTx: async (info, amount, currency, balance) => {
    var desired, i, minimum, transaction, wallet
    var estimate = await this.bitgo.estimateFee({ numBlocks: 6 })
    var fee = estimate.feePerKb
    var rate = Wallet.prototype.rates[currency.toUpperCase()]
    var recipients = {}

    if (!rate) throw new Error('no such currency: ' + currency)

    desired = (amount / rate) * 1e8
    minimum = Math.floor(desired * 0.90)
    desired = Math.round(desired)
    debug('unsignedTx', { balance: balance, desired: desired, minimum: minimum })
    if (minimum > balance) return

    if (desired > balance) desired = balance

    wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })
    for (i = 0; i < 2; i++) {
      recipients[this.config.bitgo.settlementAddress] = desired - fee

      try {
        transaction = await wallet.createTransaction({ recipients: recipients, feeRate: estimate.feePerKb })
        debug('unsignedTx', { satoshis: desired, estimate: fee, actual: transaction.fee })
      } catch (ex) {
        debug('createTransaction', ex)
        this.runtime.newrelic.noticeError(ex, { recipients: recipients, feeRate: estimate.feePerKb })
        return
      }
      if (fee <= transaction.fee) break

      fee = transaction.fee
    }

    return underscore.extend(underscore.pick(transaction, [ 'transactionHex', 'unspents', 'fee' ]),
                             { xpub: transaction.walletKeychains[0].xpub })
  }
}

Wallet.providers.coinbase = {
  purchaseBTC: (info, amount, currency) => {
    // TBD: for the moment...
    if (currency !== 'USD') throw new Error('currency ' + currency + ' payment not supported')

    return ({
      buyURL: `https://buy.coinbase.com?crypto_currency=BTC` +
                `&code=${this.config.coinbase.widgetCode}` +
                `&amount=${amount}` +
                `&address=${info.address}`
    })
  },

  recurringBTC: (info, amount, currency) => {
    // TBD: for the moment...
    if (currency !== 'USD') throw new Error('currency ' + currency + ' payment not supported')

    return ({recurringURL: `https://www.coinbase.com/recurring_payments/new?type=send&repeat=monthly` +
                `&amount=${amount}` +
                `&currency=${currency}` +
                `&to=${info.address}`
    })
  }
}
