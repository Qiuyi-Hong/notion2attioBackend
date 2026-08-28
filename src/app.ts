import express from "express";
import itemRoutes from "./routes/itemRoutes.ts";
import { errorHandler } from "./middlewares/errorHandler.ts";
import bodyParser from "body-parser";

const app = express();

app.use(bodyParser.json());
app.use(express.static("public"));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-Requested-With,content-type",
  );
  next();
});

// Routes
app.use("/items", itemRoutes);

// Global error handler (should be after routes)
app.use(errorHandler);

export default app;
