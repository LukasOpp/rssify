import { Dataset, CheerioCrawler } from "crawlee";

import { db } from "../db";
import { type Website, WebsiteSelectors } from "../types";
import { getPostDataForSelectors } from "../parser";
import { insertWebsitePosts } from "../db";
import { getLLMSelectors } from "../llm";

export const crawler = new CheerioCrawler({
    maxRequestRetries: 3,
    requestHandler: async ({ $, request }) => {
        // wait 5 secs
        // await page.waitForTimeout(10000);
        const body = $("body").html();

        // get all link elements with rel attribute containing "icon"
        const favicon = $("link[rel*='icon']").attr("href");
        const fullFaviconPath = favicon
            ? new URL(favicon, request.url)
            : new URL("/favicon.ico", request.url);

        const html = $("html").html() as string;
        await db.none(
            `UPDATE websites 
            SET latest_html = $2, 
            last_crawled = NOW(), 
            favicon_url = $3
            WHERE id = $1`,
            [request.label, html, fullFaviconPath.href],
        );

        let selectors: WebsiteSelectors = {};

        if (request.userData.useLLM) {
            if (!body) {
                throw new Error("No body found in request");
            } else {
                selectors = await getLLMSelectors(body);
            }
        } else if (request.userData.selectors) {
            selectors = request.userData.selectors;
        } else {
            const website: Website = await db.one(
                "SELECT * FROM websites WHERE id = $1",
                [request.label],
            );

            if (website) {
                selectors = {
                    post_selector: website.post_selector,
                    title_selector: website.title_selector,
                    url_selector: website.url_selector,
                    content_selector: website.content_selector,
                    date_selector: website.date_selector,
                    author_selector: website.author_selector,
                    date_regex: website.date_regex,
                    author_regex: website.author_regex,
                };
            } else {
                await Dataset.pushData({
                    url: request.url,
                    context: "No selectors found",
                });
            }
        }

        await db.none(
            `UPDATE websites 
        SET post_selector = $2,
        title_selector = $3,
        url_selector = $4,
        content_selector = $5,
        date_selector = $6,
        author_selector = $7,
        date_regex = $8,
        author_regex = $9
        WHERE id = $1`,
            [
                request.label,
                selectors.post_selector,
                selectors.title_selector,
                selectors.url_selector,
                selectors.content_selector,
                selectors.date_selector,
                selectors.author_selector,
                selectors.date_regex,
                selectors.author_regex,
            ],
        );

        if (selectors && Object.keys(selectors).length > 0) {
            const posts = await getPostDataForSelectors(
                $,
                selectors,
                request.url,
            );

            if (!request.label) {
                throw new Error("No label found in request");
            }

            await insertWebsitePosts(posts, request.label);
        }
    },
});
