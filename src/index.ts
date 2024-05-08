import dotenv from "dotenv";
dotenv.config();

import { serverPort, serverApp } from "./server";

serverApp.listen(serverPort, () => {
    console.log(`Server is up and running on port ${serverPort}`);
});
