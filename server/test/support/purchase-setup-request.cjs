'use strict';

const crypto = require('node:crypto');

/**
 * autocannon requires this to be a plain CommonJS file when running with
 * `workers`, since a function can't be cloned across worker threads.
 * `context` here is seeded from the `initialContext` option.
 */
module.exports = (req, context) => ({
  ...req,
  path: '/purchase',
  headers: { ...req.headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    userId:
      context.userIds === 'duplicate'
        ? 'stress-user-duplicate'
        : crypto.randomUUID(),
    saleId: context.saleId,
  }),
});
