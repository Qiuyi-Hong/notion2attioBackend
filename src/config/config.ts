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
  /**
   * The notes screener (ADR-0002). The key is **optional**: with none, the
   * notes are not read and the batch says so with the `N0` batch flag.
   *
   * The model is configuration because #9 left the choice reversible and #30
   * reversed it on evidence. Reasoning effort is not: #30 found raising it
   * bought no recall and cost precision, so it stays a constant in
   * `screener.ts` where nothing can turn it into a knob.
   */
  openai: {
    apiKey: string;
    model: string;
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
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-5.6-sol",
  },
};

export default config;
