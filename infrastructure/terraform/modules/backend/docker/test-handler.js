// Minimal test handler
exports.handler = async (event, context) => {
  console.log('Handler invoked');
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Hello from Lambda!' }),
  };
};
