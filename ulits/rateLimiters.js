const RateLimiter = require('./RateLimiter');
const config = require('../config');

/**
 * One shared instance per operation type, imported by both RestoreManager
 * and cleanupUnknown.js. If each file created its own RateLimiter, the
 * real concurrency cap would silently double (e.g. two independent
 * "delete" limiters of 4 = 8 actual concurrent deletes) - sharing these
 * instances is what makes the cap real.
 */
const createLimiter = new RateLimiter(config.rateLimits.createConcurrency, config.rateLimits.delayMs);
const deleteLimiter = new RateLimiter(config.rateLimits.deleteConcurrency, config.rateLimits.delayMs);
const repairLimiter = new RateLimiter(config.rateLimits.repairConcurrency, config.rateLimits.delayMs);

module.exports = { createLimiter, deleteLimiter, repairLimiter };
