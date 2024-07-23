const fastify = require("fastify");

function init() {
  const app = fastify();
  app.get("/pdf", (_, reply) => reply.send({ hello: "root" }));
  app.get("/pdf/html", (_, reply) => {
    console.log("html");
    return reply.send({ hello: "world" });
  });
  return app;
}

if (require.main === module) {
  // called directly i.e. "node app"
  init().listen({ port: 8080 }, err => {
    if (err) console.error(err);
    console.log("server listening on 8080");
  });
} else {
  // required as a module => executed on aws lambda
  module.exports = init;
}
