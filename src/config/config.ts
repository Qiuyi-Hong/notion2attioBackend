import dotenv from "dotenv";

dotenv.config({ quiet: true });

interface Config {
  port: number;
  nodeEnv: string;
  /** Where the browser is sent back to after Notion's consent screen. */
  frontendOrigin: string;
  /** The one SQLite file. Holds the Connection and the pending authorisation. */
  databasePath: string;
  notion: {
    clientId: string;
    clientSecret: string;
    /** Pinned in the Notion portal by #14; sent on both legs of the exchange. */
    redirectUri: string;
  };
}

const config: Config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  databasePath: process.env.DATABASE_PATH || "data/notion2attio.sqlite",
  notion: {
    clientId: process.env.NOTION_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.NOTION_OAUTH_CLIENT_SECRET || "",
    redirectUri:
      process.env.NOTION_OAUTH_REDIRECT_URI ||
      "http://localhost:3000/auth/notion/callback",
  },
};

export default config;
