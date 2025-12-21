import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
dotenvConfig({
    path: path.join(repoRoot, ".env"),
    override: false
});
const parsePort = (value, fallback) => {
    if (!value) {
        return fallback;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error(`Invalid port: ${value}`);
    }
    return n;
};
export const env = {
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    serverPort: parsePort(process.env.SERVER_PORT, 8643),
    clientPort: parsePort(process.env.CLIENT_PORT, 8642)
};
