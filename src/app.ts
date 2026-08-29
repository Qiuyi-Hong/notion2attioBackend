import express from "express";
import bodyParser from "body-parser";
import batchRoutes from "./routes/batchRoutes.ts";
import connectionRoutes from "./routes/connectionRoutes.ts";
import notionAuthRoutes from "./routes/notionAuthRoutes.ts";
import { errorHandler } from "./middlewares/errorHandler.ts";

const app = express();

app.use(bodyParser.json());

// No CORS: the Vite dev server proxies /api and /auth, so the browser only
// ever talks to one origin, and #15 removed cookies entirely.
app.use("/auth", notionAuthRoutes);
app.use("/api/connection", connectionRoutes);
app.use("/api/batches", batchRoutes);

// Global error handler (should be after routes)
app.use(errorHandler);

export default app;
