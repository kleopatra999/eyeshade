/* utilities for Brave's use of Joi

   not really extensive enough for its own package...

*/

var base58check = require('bs58check')
var bitcoin = require('bitcoinjs-lib')
var countryCodes = require('country-list')()
var currencyCodes = require('currency-codes')
var Joi = require('joi')
var ledgerPublisher = require('ledger-publisher')

module.exports = Joi.extend({
  base: Joi.string(),
  name: 'string',
  language: {
    badBase58: 'bad Base58 encoding',
    badFormat: 'invalid format',
    badCountryCode: 'invalid country code',
    badCurrencyCode: 'invalid currency code'
  },
  rules: [
    { name: 'base58',

      validate (params, value, state, options) {
        try { base58check.decode(value) } catch (err) {
          return this.createError('string.badBase58', { v: value }, state, options)
        }

        return value
      }
    },

    { name: 'countryCode',

      validate (params, value, state, options) {
        var entry = countryCodes.getName(value)

        if (!entry) return this.createError('string.badCountryCode', { v: value }, state, options)

        return value
      }
    },

    { name: 'currencyCode',

      validate (params, value, state, options) {
        var entry = currencyCodes.code(value)

        if (!entry) return this.createError('string.badCurrencyCode', { v: value }, state, options)

        return value
      }
    },

    { name: 'publisher',

      validate (params, value, state, options) {
        value = value.toLowerCase()
        if (!ledgerPublisher.isPublisher(value)) return this.createError('string.badFormat', { v: value }, state, options)

        return value
      }
    },

    { name: 'Xpub',

      // courtesy of the good folks at BitGo!
      validate (params, value, state, options) {
        if (value.substr(0, 4) !== 'xpub') return this.createError('string.badFormat', { v: value }, state, options)

        try { bitcoin.HDNode.fromBase58(value) } catch (err) {
          return this.createError('string.badBase58', { v: value }, state, options)
        }

        return value
      }
    }
  ]
})
