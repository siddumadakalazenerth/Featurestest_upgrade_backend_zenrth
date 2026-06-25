const multer = require('multer');

function errorHandler(err, _req, res, _next) {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    console.error('[error]', err.message);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
  return res.status(500).json({ error: 'Unknown error' });
}

module.exports = { errorHandler };
