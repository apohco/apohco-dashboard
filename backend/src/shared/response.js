function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.FRONTEND_URL || '*',
    },
    body: JSON.stringify(body),
  };
}

function redirect(location) {
  return {
    statusCode: 302,
    headers: { Location: location },
    body: '',
  };
}

// Wraps a Lambda handler so thrown errors (with an optional `statusCode`,
// as set by verifyToken/authorize) become consistent JSON error responses
// instead of raw 500s.
function withErrorHandling(handler) {
  return async (event, context) => {
    try {
      return await handler(event, context);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode === 500) {
        console.error(err);
      }
      return json(statusCode, { message: err.message || 'Internal server error' });
    }
  };
}

module.exports = { json, redirect, withErrorHandling };
