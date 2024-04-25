// import cron from "node-cron";
import dotenv from "dotenv";
dotenv.config();

import { serverPort, serverApp } from "./server";

// cron.schedule("*/10 * * * *", async () => {
//     console.log("Running cron job every 10 minutes");
//     const websitesToCrawl: Website[] = await db.any("SELECT * FROM websites WHERE last_crawled IS NULL OR last_crawled < NOW() - INTERVAL '1 day'");
//     console.log(websitesToCrawl);
// })

serverApp.listen(serverPort, () => {
    console.log(`Server is up and running on port ${serverPort}`);
});

