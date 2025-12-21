import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./env.js";

const buildServer = async () => {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: [`http://localhost:${env.clientPort}`, `http://127.0.0.1:${env.clientPort}`],
    credentials: true
  });

  app.get("/api/health", () => {
    return {
      ok: true,
      serverTime: new Date().toISOString(),
      hasOpenAIKey: env.openaiApiKey.length > 0
    };
  });

  return app;
};

const main = async () => {
  const app = await buildServer();

  try {
    await app.listen({
      host: "0.0.0.0",
      port: env.serverPort
    });
  } catch (err) {
    app.log.error(err);
    process.exitCode = 1;
  }
};

void main();
