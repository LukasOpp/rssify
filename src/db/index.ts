import pgPromise from "pg-promise";
import { type Post } from "../types";

if (!process.env.PG_USER) {
    throw new Error("PG_USER is required");
}

if (!process.env.PG_PASSWORD) {
    throw new Error("PG_PASSWORD is required");
}

if (!process.env.PG_HOST) {
    throw new Error("PG_HOST is required");
}

if (!process.env.PG_PORT) {
    throw new Error("PG_PORT is required");
}

if (!process.env.PG_DATABASE) {
    throw new Error("PG_DATABASE is required");
}

const pgp = pgPromise({
    /* Initialization Options */
});

export const db = pgp({
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    database: process.env.PG_DATABASE,
});

export const insertWebsitePosts = async (
    posts: Post[],
    websiteId: string
): Promise<void> => {
    return new Promise((resolve, reject) => {
        const cs = new pgp.helpers.ColumnSet(
            ["website_id", "title", "url", "content", "date", "author"],
            { table: "posts" }
        );

        const postsWithWebsiteId = posts.map((post) => {
            return {
                website_id: websiteId,
                ...post,
            };
        });

        const query = pgp.helpers.insert(postsWithWebsiteId, cs);

        // Execute the query
        db.none(query)
            .then(() => {
                resolve();
            })
            .catch((error) => {
                reject(error);
            });
    });
};