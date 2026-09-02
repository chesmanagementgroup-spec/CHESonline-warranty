'use strict';

/**
 * Express 4 does not catch a rejected promise from an async handler, so a
 * throw inside one leaves the request open until the client gives up. Wrapping
 * the handler turns that into the normal error response.
 */
module.exports = function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
};
