import dotenv from "dotenv";

dotenv.config({ quiet: true });

interface Config {
  port: number;
  nodeEnv: string;
  /** Where the browser is sent back to after Notion's consent screen. */
  frontendOrigin: string;
  /**
   * The one SQLite file. Holds the Connection, the pending authorisation, the
   * runs, and the checkpoints the graph writes.
   */
  databasePath: string;
  /**
   * The `Deal stage` every Deal is proposed under. No Notion column holds one
   * and we never read Attio, so the value has to come from somewhere the
   * reviewer can see and change — a batch flag, not a constant in the emitter
   * (#18). `Lead` is Attio's own Deals template's example value.
   */
  dealStage: string;
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
  dealStage: process.env.DEAL_STAGE || "Lead",
  notion: {
    clientId: process.env.NOTION_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.NOTION_OAUTH_CLIENT_SECRET || "",
    redirectUri:
      process.env.NOTION_OAUTH_REDIRECT_URI ||
      "http://localhost:3000/auth/notion/callback",
  },
};

export default config;
