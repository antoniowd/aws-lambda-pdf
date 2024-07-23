const fastify = require("fastify")({ logger: true });
const puppeteer = require("puppeteer");

const PORT = process.env.PORT || 8080;

fastify.post("/pdf", async (request, reply) => {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({ format: "A4" });

    await page.close();

    await browser.close();
    return pdf;
  } catch (error) {
    throw new Error(error.message);
  }
});

fastify
  .listen({ port: PORT })
  .then(address => {
    console.log(`Server listening on ${address}`);
  })
  .catch(err => {
    fastify.log.error(err);
    process.exit(1);
  });
