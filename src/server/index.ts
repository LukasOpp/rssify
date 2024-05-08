import express, { Express } from "express";

import apiRouter from "./routes/api";
import pageRouter from "./routes/pages";

export const serverApp: Express = express();
export const serverPort = process.env.PORT || 3000;
const apiVersion = process.env.API_VERSION || "v1";

serverApp.use(express.static("public"));
serverApp.use(express.json());
serverApp.use(express.urlencoded({ extended: true })); // support encoded bodies
serverApp.set("view engine", "pug");
serverApp.set("views", "./src/views");

serverApp.use(`/api/${apiVersion}`, apiRouter);
serverApp.use(`/`, pageRouter);