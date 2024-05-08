import * as cheerio from "cheerio";
import { Request, Response, Router } from "express";

import { db } from "../../db";
import { crawler } from "../../crawler";
import { type WebsiteSelectors, type Website, type Post } from "../../types";
import { formatURL } from "../../util/helpers";
import { getLLMRegexSuggestion } from "../../llm";
import { getPostDataForSelectors } from "../../parser";
import { insertWebsitePosts } from "../../db";
import { preferredDateFormatting } from "../../util/date";

const apiRouter = Router();

apiRouter.get("/ping", (req: Request, res: Response) => {
    res.send("pong");
});

apiRouter.post("/feed", async (req: Request, res: Response) => {
    const { title, description } = req.body as {
        title: string;
        description: string;
    };

    try {
        const response = await db.one(
            "INSERT INTO feeds(title, description) VALUES($1, $2) RETURNING id",
            [title, description],
        );

        const feedId = response.id;

        res.redirect(`/feed/${feedId}`);
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});
apiRouter.post("/feed/:id", async (req: Request, res: Response) => {
    const id = req.params.id;

    if (req.body.delete) {
        try {
            await db.none("DELETE FROM websites WHERE feed_id = $1", [id]);
            await db.none("DELETE FROM feeds WHERE id = $1", [id]);
            res.redirect("/");
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Internal server error" });
        }
    }
});

apiRouter.post("/website/:id/wizard", async (req: Request, res: Response) => {
    const websiteId = req.params.id;
    const {
        post_selector,
        title_selector,
        url_selector,
        content_selector,
        date_selector,
        author_selector,
        date_regex,
        author_regex,
    } = req.body;

    const selectors: WebsiteSelectors = {
        post_selector,
        title_selector,
        url_selector,
        content_selector,
        date_selector,
        author_selector,
        date_regex,
        author_regex,
    };

    // check if selectors are valid jquery selectors

    try {
        const website: Website = await db.one(
            "SELECT * FROM websites WHERE id = $1",
            [websiteId],
        );

        if (!website.latest_html) {
            throw new Error("No HTML found for website");
        }

        const $ = cheerio.load(website.latest_html);

        let posts: Post[] = [];

        try {
            posts = await getPostDataForSelectors($, selectors, website.url);

            // let llm suggest regex for date if date selector is present but posts have no date
            if (date_selector && posts.every((post) => !post.date)) {
                const regex = await getLLMRegexSuggestion(
                    $,
                    post_selector,
                    "date",
                    date_selector,
                );
                if (regex) {
                    selectors.date_regex = regex;
                }

                posts = await getPostDataForSelectors(
                    $,
                    selectors,
                    website.url,
                );
            }

            // let llm suggest regex for author if author selector is present but posts have no author
            if (author_selector && posts.every((post) => !post.author)) {
                const regex = await getLLMRegexSuggestion(
                    $,
                    post_selector,
                    "author",
                    author_selector,
                );
                if (regex) {
                    selectors.author_regex = regex;
                }

                posts = await getPostDataForSelectors(
                    $,
                    selectors,
                    website.url,
                );
            }
        } catch (error) {
            console.error(error);
            res.status(500).send("Syntax error in selectors");
            return;
        }

        if (posts.length === 0) {
            res.status(400).send("No posts found");
            return;
        }

        posts.forEach((post) => {
            if (post.date) {
                post.date = preferredDateFormatting.format(new Date(post.date));
            }
        });

        res.render("partials/posts/website-post-list", {
            website,
            posts,
            newDateRegex: selectors.date_regex,
            newAuthorRegex: selectors.author_regex,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Server error");
    }
});

apiRouter.post("/website", async (req: Request, res: Response) => {
    const { url, feedId } = req.body as { url: string; feedId: string };

    const formattedUrl = formatURL(url);

    try {
        const response = await db.one(
            "INSERT INTO websites(url, feed_id) VALUES($1, $2) RETURNING id",
            [formattedUrl, feedId],
        );

        const websiteId = response.id;

        await crawler.run([
            {
                url: formattedUrl,
                label: websiteId,
                userData: { label: websiteId, useLLM: true },
            },
        ]);

        const posts: Post[] = await db.any(
            "SELECT * FROM posts WHERE website_id = $1",
            [websiteId],
        );

        if (posts.length === 0) {
            res.redirect(`/website/${websiteId}/wizard`);
            return;
        }

        res.redirect(`/website/${websiteId}`);
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});

apiRouter.post("/website/:id", async (req: Request, res: Response) => {
    const websiteId = req.params.id;
    try {
        if (req.body.delete) {
            const response = await db.one(
                "SELECT feed_id FROM websites WHERE id = $1",
                [websiteId],
            );
            if (!response) {
                res.status(404).send({ message: "Website not found" });
                return;
            }

            await db.none("DELETE FROM posts WHERE website_id = $1", [
                websiteId,
            ]);
            await db.none("DELETE FROM websites WHERE id = $1", [websiteId]);

            res.redirect(`/feed/${response.feed_id}`);
        } else if (req.body.url) {
            const website: Website = await db.one(
                "SELECT * FROM websites WHERE id = $1",
                [websiteId],
            );

            if (!website) {
                res.status(404).send({ message: "Website not found" });
                return;
            }

            const formattedUrl = formatURL(req.body.url);

            await db.none("UPDATE websites SET url = $1 WHERE id = $2", [
                formattedUrl,
                websiteId,
            ]);

            await crawler.run([
                {
                    url: formattedUrl,
                    label: websiteId,
                    userData: { label: websiteId, useLLM: true },
                },
            ]);

            const posts: Post[] = await db.any(
                "SELECT * FROM posts WHERE website_id = $1",
                [websiteId],
            );

            if (posts.length === 0) {
                res.redirect(`/website/${websiteId}/wizard`);
                return;
            }

            res.redirect(`/website/${websiteId}`);
        } else {
            const website: Website = await db.one(
                "SELECT * FROM websites WHERE id = $1",
                [req.params.id],
            );

            if (!website) {
                res.status(404).send({ message: "Website not found" });
                return;
            }

            const selectors: WebsiteSelectors = {
                post_selector: req.body.post_selector,
                title_selector: req.body.title_selector,
                url_selector: req.body.url_selector,
                content_selector: req.body.content_selector,
                date_selector: req.body.date_selector,
                author_selector: req.body.author_selector,
                date_regex: req.body.date_regex,
                author_regex: req.body.author_regex,
            };

            await db.none(
                "UPDATE websites SET post_selector = $1, title_selector = $2, url_selector = $3, content_selector = $4, date_selector = $5, author_selector = $6, date_regex = $7, author_regex = $8 WHERE id = $9",
                [
                    selectors.post_selector,
                    selectors.title_selector,
                    selectors.url_selector,
                    selectors.content_selector,
                    selectors.date_selector,
                    selectors.author_selector,
                    selectors.date_regex,
                    selectors.author_regex,
                    website.id,
                ],
            );

            await db.none("DELETE FROM posts WHERE website_id = $1", [
                website.id,
            ]);

            if (website.latest_html) {
                const $ = cheerio.load(website.latest_html);
                const posts: Post[] = await getPostDataForSelectors(
                    $,
                    selectors,
                    website.url,
                );
                await insertWebsitePosts(posts, website.id);
            } else {
                await crawler.run([
                    {
                        url: website.url,
                        userData: { selectors, label: website.id },
                    },
                ]);
            }

            res.redirect(`/website/${website.id}`);
        }
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});

apiRouter.post("/update/all", async (req: Request, res: Response) => {
    try {
        const websitesToUpdate: Website[] = await db.any("SELECT * FROM websites WHERE last_crawled IS NULL OR last_crawled < NOW() - INTERVAL '1 day'");

        if (websitesToUpdate.length === 0) {
            res.status(200).send({ message: "All websites up to date" });
            return;
        }

        await crawler.run(
            websitesToUpdate.map((website) => ({
                url: website.url,
                label: website.id,
                userData: { label: website.id },
            })),
        );

        res.status(200).send({ message: `${websitesToUpdate.length} Websites updated` });
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});

export default apiRouter;
