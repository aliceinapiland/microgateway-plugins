'use strict';

var debug = require('debug')('plugin:oauth');
var url = require('url');
var jwt = require('jsonwebtoken');
var request = require('request');
var _ = require('lodash');

var authHeaderRegex = /Bearer (.+)/;
var PRIVATE_JWT_VALUES = ['application_name', 'client_id', 'api_product_list', 'iat', 'exp'];

module.exports.init = function(config, logger, stats) {

  var apiKeyCache = {};

  var middleware = function(req, res, next) {

    var authHeaderName = config['authorization-header'] ? config['authorization-header'] : 'authorization';
    var apiKeyHeaderName = config['api-key-header'] ? config['api-key-header'] : 'x-api-key';
    var apiKey;

    if (!req.headers[authHeaderName]) {
      if (apiKey = req.headers[apiKeyHeaderName]) {
        exchangeApiKeyForToken(req, res, next, config, logger, stats, middleware, apiKey);
      } else if (req.reqUrl && req.reqUrl.query && (apiKey = req.reqUrl.query[apiKeyHeaderName])) {
        exchangeApiKeyForToken(req, res, next, config, logger, stats, middleware, apiKey);
      } else if (config.allowNoAuthorization) {
        return next();
      } else {
        return sendError(req, res, next, logger, stats, 'missing_authorization', 'Missing Authorization header');
      }
    } else {
      var header = authHeaderRegex.exec(req.headers[authHeaderName]);
      if (!header || header.length < 2) {
        return sendError(req, res, next, logger, stats, 'invalid_request', 'Invalid Authorization header');
      }
      var token = header[1];
      delete(req.headers[authHeaderName]); // never pass this header to target

      verify(token, config, logger, stats, middleware, req, res, next);
    }
  }

  var exchangeApiKeyForToken = function(req, res, next, config, logger, stats, middleware, apiKey) {
    var cacheControl = req.headers['cache-control'];
    if (!cacheControl || (cacheControl && cacheControl.indexOf('no-cache') < 0)) { // caching is allowed
      var token = apiKeyCache[apiKey];
      if (token) {
        if (Date.now()/1000 < token.exp) { // not expired yet (token expiration is in seconds)
          debug('api key cache hit', apiKey);
          return authorize(req, res, next, logger, stats, token);
        } else {
          delete apiKeyCache[apiKey];
          debug('api key cache expired', apiKey);
        }
      } else {
        debug('api key cache miss', apiKey);
      }
    }

    if (!config.verify_api_key_url) return sendError(req, res, next, logger, stats, 'invalid_request', 'API Key Verification URL not configured');
    request({
      url: config.verify_api_key_url,
      method: 'POST',
      json: {'apiKey': apiKey},
      headers: {'x-dna-api-key': apiKey}
    }, function(err, response, body) {
      if (err) return sendError(req, res, next, logger, stats, 'gateway_timeout', err.message);
      if (response.statusCode !== 200) return sendError(req, res, next, logger, stats, 'access_denied', response.statusMessage);
      verify(body, config, logger, stats, middleware, req, res, next, apiKey);
    });
  }

  var verify = function(token, config, logger, stats, middleware, req, res, next, apiKey) {
    var options = {
      algorithms: ['RS256'],
      ignoreExpiration: false,
      audience: undefined,
      issuer: undefined
    };

   jwt.verify(token && token.token ? token.token: token, config.public_key, options, function(err, decodedToken) {

      if (err) {

        if (config.allowInvalidAuthorization) {

          console.warn('ignoring err', err);
          return next();

        } else {

          if (err.name === 'TokenExpiredError') {
            return sendError(req, res, next, logger, stats, 'access_denied');
          }

          // todo: check other properties and/or give client more info?
          return sendError(req, res, next, logger, stats, 'invalid_token');
        }
      }

      authorize(req, res, next, logger, stats, decodedToken, apiKey);
    });
  };

  return {

    onrequest: function(req, res, next) {
      middleware(req, res, next);
    },

    api_key_cache_size: function() {
      return Object.keys(apiKeyCache).length;
    },

    api_key_cache_clear: function() {
      var deleted = 0;
      Object.keys(apiKeyCache).forEach(function(key) {
        delete apiKeyCache[key];
        deleted++;
      });
      return deleted;
    }

  };

  function authorize(req, res, next, logger, stats, decodedToken, apiKey) {
    if (checkIfAuthorized(config, res.proxy, decodedToken)) {
      req.token = decodedToken;

      var authClaims = _.omit(decodedToken, PRIVATE_JWT_VALUES);
      req.headers['x-authorization-claims'] = new Buffer(JSON.stringify(authClaims)).toString('base64');

      if (apiKey) {
        var cacheControl = req.headers['cache-control'];
        if (!cacheControl || (cacheControl && cacheControl.indexOf('no-cache') < 0)) { // caching is allowed
          // default to now (in seconds) + 30m if not set
          decodedToken.exp = decodedToken.exp || +(((Date.now()/1000) + 1800).toFixed(0));
          apiKeyCache[apiKey] = decodedToken;
          debug('api key cache store', apiKey);
        } else {
          debug('api key cache skip', apiKey);
        }
      }

      next();
    } else {
      return sendError(req, res, next, logger, stats, 'access_denied');
    }
  }

}

// from the product name(s) on the token, find the corresponding proxy
// then check if that proxy is one of the authorized proxies in bootstrap
function checkIfAuthorized(config, proxy, decodedToken) {

  if (!decodedToken.api_product_list) { return false; }

  return decodedToken.api_product_list.some(function(product) {

    var validProxyNames = config.product_to_proxy[product];
    if (!validProxyNames) { return false; }

    return validProxyNames.indexOf(proxy.name) >= 0;
  });
}

function sendError(req, res, next, logger, stats, code, message) {

  switch(code) {
    case 'invalid_request':
      res.statusCode = 400;
      break;
    case 'access_denied':
      res.statusCode = 403;
      break;
    case 'invalid_token':
    case 'missing_authorization':
    case 'invalid_authorization':
      res.statusCode = 401;
      break;
    case 'gateway_timeout':
      res.statusCode = 504;
      break;
    default:
      res.statusCode = 500;
  }

  var response = {
    error: code,
    error_description: message
  };

  debug('auth failure', res.statusCode, code, message ? message : '', req.headers, req.method, req.url);
  logger.error({req: req, res: res}, 'oauth');

  if (!res.finished) res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(response));
  stats.incrementStatusCount(res.statusCode);
  next(code, message);
  return code;
}
