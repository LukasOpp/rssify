import * as cheerio from "cheerio";
import { Request, Response, Router } from "express";

import { serverApp } from "../index";
import { db } from "../../db";
import { type Feed, type Website, type Post } from "../../types";
import { preferredDateFormatting } from "../../util/date";

const pageRouter = Router();

pageRouter.get("/", async (req: Request, res: Response): Promise<void> => {
    try {
        const feeds: Feed[] = await db.any("SELECT * FROM feeds");
        res.render("index", { feeds });
    } catch (error: unknown) {
        console.error(error);
        res.status(500).send("Internal server error");
    }
});

pageRouter.get(
    "/feed/:id",
    async (req: Request, res: Response): Promise<void> => {
        if (!req.params.id || req.params.id === "") {
            res.status(400).send("Feed ID is required");
            return;
        }

        try {
            const feed: Feed = await db.one(
                "SELECT * FROM feeds WHERE id = $1",
                [req.params.id],
            );
            const websites: Website[] = await db.any(
                "SELECT * FROM websites WHERE feed_id = $1",
                [feed.id],
            );
            const posts: Post[] = websites.length
                ? await db.any(
                      "SELECT * FROM posts WHERE website_id IN ($1:csv) ORDER BY date DESC NULLS LAST",
                      [websites.map((website) => website.id)],
                  )
                : [];

            posts.forEach((post) => {
                if (post.date) {
                    post.date = preferredDateFormatting.format(
                        new Date(post.date),
                    );
                }
            });

            const postsWithWebsite = posts.map((post) => {
                const website = websites.find(
                    (website) => website.id === post.website_id,
                );
                return {
                    ...post,
                    website,
                };
            });

            res.render("feed", { feed, websites, posts: postsWithWebsite });
        } catch (error: unknown) {
            console.error(error);
            res.status(500).send("Internal server error");
        }
    },
);

pageRouter.get("/website/:id", async (req: Request, res: Response) => {
    if (!req.params.id || req.params.id === "") {
        res.status(400).send("Website ID is required");
        return;
    }

    try {
        const website: Website = await db.one(
            "SELECT * FROM websites WHERE id = $1",
            [req.params.id],
        );
        const feed: Feed = await db.one("SELECT * FROM feeds WHERE id = $1", [
            website.feed_id,
        ]);
        const posts: Post[] = await db.any(
            "SELECT * FROM posts WHERE website_id = $1",
            [website.id],
        );
        posts.forEach((post) => {
            if (post.date) {
                post.date = preferredDateFormatting.format(new Date(post.date));
            }
        });
        res.render("website", { feed, website, posts });
    } catch (error) {
        console.error(error);
        res.status(500).send("Internal server error");
    }
});

pageRouter.get("/website/:id/wizard", async (req: Request, res: Response) => {
    if (!req.params.id || req.params.id === "") {
        res.status(400).send("Website ID is required");
        return;
    }

    try {
        const website: Website = await db.one(
            "SELECT * FROM websites WHERE id = $1",
            [req.params.id],
        );

        const feed: Feed = await db.one("SELECT * FROM feeds WHERE id = $1", [
            website.feed_id,
        ]);

        const wizardCodeInject = `
            <script>
                let blockClickEvents = true;

                // const WIZARD_ERRORS = {
                //     SELECTION_OUTSIDE_PARENT: "SELECTION_OUTSIDE_PARENT",
                // }

                window.addEventListener("message", (event) => {
                    if (event.data === "toggleClickEvents") {
                        blockClickEvents = !blockClickEvents;
                        document.body.classList.toggle("selection-mode-active");
                    }
                });

                document.addEventListener("DOMContentLoaded", () => {
                    document.body.classList.add("selection-mode-active");

                    document.body.addEventListener("click", (event) => {
                        if (blockClickEvents) event.preventDefault();

                        // if (document.querySelector(".post-selection-container")) {
                        //     if (!event.target.closest(".post-selection-container")) {
                        //         window.parent.postMessage({ wizardError: WIZARD_ERRORS.SELECTION_OUTSIDE_PARENT }, "*");
                        //         return;
                        //     }
                        // }

                        const path = event.composedPath();
                        const target = path[0];

                        const pathSelector = path.reverse().map((element, i) => {
                            // if (element.id && i !== path.length - 1) {
                            //     return element.tagName.toLowerCase() + "#" + element.id;
                            // }


                            // add nth-child selector if element has siblings
                            // if (element.tagName) {
                            //     const siblings = Array.from(element.parentElement?.children || []);
                            //     const index = siblings.indexOf(element);
                            //     const nthChild = siblings.length > 1 ? ":nth-child(" + Number(index + 1) + ")" : "";
                            //     return element.tagName.toLowerCase() + nthChild;
                            // }

                            // if (element.className) {
                            //     return element.tagName.toLowerCase() + "." + element.className.trim().split(" ").join(".");
                            // }
                            if (element.tagName 
                                && element.tagName.toLowerCase() !== "html" 
                                && element.tagName.toLowerCase() !== "head" 
                                && element.tagName.toLowerCase() !== "body"
                            ) {
                                return element.tagName.toLowerCase();
                            }

                            return "";
                        }).filter(el => el).join(" > ").trim()
                            .replace(".post-selection-container", "")
                            .replace(".title-selection-container", "")
                            .replace(".url-selection-container", "")
                            .replace(".content-selection-container", "")
                            .replace(".date-selection-container", "")
                            .replace(".author-selection-container", "")
                            .replace(".selection-mode-active", "");



                        window.parent.postMessage({ selectedElementPath: pathSelector }, "*");
                    });
                });
            </script>
            <style>
                .selection-mode-active:not(:has(.post-selection-container)) *:hover:not(:has(*:hover)) {
                    outline: 3px solid #00000033;
                    // make outline appear on top of other elements
                    z-index: 100000;

                }
                .selection-mode-active:not(:has(.post-selection-container)) * {
                    cursor: crosshair;
                }
                .selection-mode-active:has(.post-selection-container) * {
                    cursor: not-allowed;
                }
                .selection-mode-active:has(.post-selection-container) .post-selection-container * {
                    cursor: crosshair;
                }
                .selection-mode-active .post-selection-container {
                    outline: 20000px solid #00000069 !important;
                }
                .selection-mode-active .title-selection-container {
                    outline: 2px solid green !important;
                }
                .selection-mode-active .url-selection-container {
                    outline: 2px solid blue !important;
                }
                .selection-mode-active .content-selection-container {
                    outline: 2px solid yellow !important;
                }
                .selection-mode-active .date-selection-container {
                    outline: 2px solid orange !important;
                }
                .selection-mode-active .author-selection-container {
                    outline: 2px solid purple !important;
                }
            </style>
            `;

        if (!website.latest_html) {
            throw new Error("No HTML found for website");
        }

        // Inject the wizard code into the HTML
        website.latest_html = website.latest_html?.replace(
            "</head>",
            `${wizardCodeInject}</head>`,
        );

        // fix relative URLs
        const $ = cheerio.load(website.latest_html);
        const base = new URL(website.url);
        $("*").each((i, el) => {
            const href = $(el).attr("href");
            if (href && !href.startsWith("http")) {
                $(el).attr("href", new URL(href, base).href);
            }
            const src = $(el).attr("src");
            if (src && !src.startsWith("http")) {
                $(el).attr("src", new URL(src, base).href);
            }
        });

        website.latest_html = $.html();

        res.render("website-wizard", { website, feed });
    } catch (error) {
        console.error(error);
        res.status(500).send(JSON.stringify(error));
    }
});

export default pageRouter;
