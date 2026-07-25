import fastify from 'fastify';

const server = fastify({ logger: true });

// Always returns 200 OK
server.post('/mock/success', async (request, reply) => {
  return reply.status(200).send({ status: 'ok' });
});

// Always returns 500
server.post('/mock/fail', async (request, reply) => {
  return reply.status(500).send({ error: 'Internal Server Error' });
});

// Always times out (or takes a very long time)
server.post('/mock/timeout', async (request, reply) => {
  await new Promise(resolve => setTimeout(resolve, 15000));
  return reply.status(200).send({ status: 'delayed' });
});

// Logs headers and body, returns 200 (useful for assertions)
server.post('/mock/echo', async (request, reply) => {
  return reply.status(200).send({
    headers: request.headers,
    body: request.body
  });
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 4000;
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Mock target listening on port ${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
