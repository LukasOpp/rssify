import express, { Request, Response, NextFunction, Express } from "express";
import pgPromise from "pg-promise";
import cron from "node-cron";
import dotenv from "dotenv";
import {
    PlaywrightCrawler,
    ProxyConfiguration,
    Dataset,
    CheerioCrawler,
} from "crawlee";
import * as cheerio from "cheerio";
import { formatURL } from "./js/helpers";
import OpenAI from "openai";
import { resolve } from "path";
import { get } from "http";

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
}

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

interface Feed {
    id: string;
    title: string;
    description?: string;
    previewLinks?: string[];
}

interface WebsiteSelectors {
    post_selector?: string;
    title_selector?: string;
    url_selector?: string;
    content_selector?: string;
    date_selector?: string;
    author_selector?: string;
}

interface Website extends WebsiteSelectors {
    id: string;
    feed_id: string;
    url: string;
    favicon_url?: string;
    latest_html?: string;
    last_crawled?: Date;
}

interface Post {
    website_id?: string;
    title?: string;
    url?: string;
    content?: string;
    date?: string | undefined;
    dateFormatted?: string;
    author?: string;
}

const app: Express = express();

const pgp = pgPromise({
    /* Initialization Options */
});

const db = pgp({
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    database: process.env.PG_DATABASE,
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const getDataForSelector = (parent: cheerio.Cheerio<cheerio.Element>, selector: string | undefined): string | undefined => {
    if (!selector) {
        return undefined;
    }

    const attribute = selector.match(/.*\[(.*?)\]/)?.[1];
    const selectorWithoutAttribute = selector.replace(/\[.*\]/, "");

    if (attribute) {
        return parent.find(selectorWithoutAttribute).first().attr(attribute);
    } else {
        return parent.find(selector).first().text();
    }
}

const getPostDataForSelectors = async (
    $: cheerio.CheerioAPI,
    selectors: WebsiteSelectors,
    origin: string
): Promise<Post[]> => {
    const postContainers = $("body").find(selectors.post_selector);

    const posts: Post[] = postContainers
        .map((i, postContainer) => {
            const postElement = $(postContainer);
            const title = getDataForSelector(postElement, selectors.title_selector);
            let url = getDataForSelector(postElement, selectors.url_selector);
            
            if (url && !url.startsWith("http")) {
                const baseUrl = new URL(origin);
                url = new URL(url, baseUrl).href;
            }
            const content = getDataForSelector(postElement, selectors.content_selector);

            let date = getDataForSelector(postElement, selectors.date_selector)
            if (date) {
                const dateObject = new Date(date);
                if (isNaN(dateObject.getTime())) {
                    date = undefined;
                } else {
                    date = dateObject.toISOString();
                }
                
            }

            let author = getDataForSelector(postElement, selectors.author_selector)

            return {
                title,
                url,
                content,
                date,
                author,
            };
        })
        .get();
    return posts;
};

const insertWebsitePosts = async (
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

const initialCrawler = new CheerioCrawler({
    // proxyConfiguration: new ProxyConfiguration({ proxyUrls: ['a'] }),
    requestHandler: async ({ $, request }) => {
        try {
            const body = $("body").html() as string;
            const favicon = $('link[rel="icon"]').attr("href");
            const fullFaviconPath = favicon
                ? new URL(favicon, request.url)
                : new URL("/favicon.ico", request.url);

            let selectors: WebsiteSelectors = {};

            if (request.userData.useLLM) {
                const answer = await openai.chat.completions.create({
                    model: "gpt-4-turbo-preview",
                    messages: [
                        {
                            content: `give me the jquery selectors for post, post title, post url, post content, post date and post author for the following html, but respond to me only as a JSON with keys "post_selector", "title_selector", "url_selector", "content_selector", "date_selector" and "author_selector". make every selector except "post_selector" relative to "post_selector". it is okay to set selectors to null if you can't find anything good. please find the most explicit data, for example you should prefer timestamps over relative datetime like "3 hours ago". include attributes in the selector with brackets, not with an @. you may use jquery selectors like :contains and :first. \n\n${body}`,
                            role: "system",
                        },
                    ],
                });

                if (answer.choices[0].message.content) {
                    try {
                        const potentialJson =
                            answer.choices[0].message.content.match(
                                /\{[^}]*\}/
                            )?.[0];
                        if (!potentialJson) {
                            throw new Error("No JSON found in OpenAI response");
                        }
                        const answerJson = JSON.parse(potentialJson);

                        selectors = {
                            post_selector: answerJson.post_selector,
                            title_selector: answerJson.title_selector,
                            url_selector: answerJson.url_selector,
                            content_selector: answerJson.content_selector,
                            date_selector: answerJson.date_selector,
                            author_selector: answerJson.author_selector,
                        };
                    } catch (error) {
                        await Dataset.pushData({
                            url: request.url,
                            context: "OpenAI response",
                            error: JSON.stringify(error),
                            answer: JSON.stringify(
                                answer.choices[0].message.content
                            ),
                        });
                    }
                }
            } else if (request.userData.selectors) {
                selectors = request.userData.selectors;
            } else {
                const website: Website = await db.one(
                    "SELECT * FROM websites WHERE id = $1",
                    [request.label]
                );

                if (website) {
                    selectors = {
                        post_selector: website.post_selector,
                        title_selector: website.title_selector,
                        url_selector: website.url_selector,
                        content_selector: website.content_selector,
                        date_selector: website.date_selector,
                        author_selector: website.author_selector,
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
            SET latest_html = $1, 
            last_crawled = NOW(), 
            favicon_url = $2, 
            post_selector = $3,
            title_selector = $4,
            url_selector = $5,
            content_selector = $6,
            date_selector = $7,
            author_selector = $8
            WHERE id = $9`,
                [
                    $("html").html(),
                    fullFaviconPath.href,
                    selectors.post_selector,
                    selectors.title_selector,
                    selectors.url_selector,
                    selectors.content_selector,
                    selectors.date_selector,
                    selectors.author_selector,
                    request.label,
                ]
            );

            if (selectors && Object.keys(selectors).length > 0) {
                const posts = await getPostDataForSelectors($, selectors, request.url);

                if (!request.label) {
                    throw new Error("No label found in request");
                }

                await insertWebsitePosts(posts, request.label);
            }
        } catch (error) {
            Dataset.pushData({
                url: request.url,
                context: "Cheerio error",
            });
        }
    },
});

const preferredDateFormatting = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
});

// const {value} = await db.one('SELECT 123 as value');

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // support encoded bodies
app.set("view engine", "pug");
app.set("views", "./src/views");

const port = process.env.PORT || 3000;
const apiVersion = process.env.API_VERSION || "v1";

app.get(
    "/",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const feeds: Feed[] = await db.any("SELECT * FROM feeds");
            res.render("index", { feeds });
        } catch (error: unknown) {
            next(new Error((error as Error).message));
        }
    }
);
app.get(
    "/feed/:id",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!req.params.id || req.params.id === "") {
            next(new Error("Feed ID is required"));
            return;
        }

        try {
            const feed: Feed = await db.one(
                "SELECT * FROM feeds WHERE id = $1",
                [req.params.id]
            );
            const websites: Website[] = await db.any(
                "SELECT * FROM websites WHERE feed_id = $1",
                [feed.id]
            );
            const posts: Post[] = websites.length
                ? await db.any(
                      "SELECT * FROM posts WHERE website_id IN ($1:csv)",
                      [websites.map((website) => website.id)]
                  )
                : [];

            const postsWithWebsite = posts.map((post) => {
                const website = websites.find(
                    (website) => website.id === post.website_id
                );
                return {
                    ...post,
                    website,
                };
            });

            res.render("feed", { feed, websites, posts: postsWithWebsite });
        } catch (error: unknown) {
            next(new Error((error as Error).message));
        }
    }
);

app.get(`/api/${apiVersion}/ping`, (req: Request, res: Response) => {
    res.send("pong");
});

app.post(`/api/${apiVersion}/feed`, async (req: Request, res: Response) => {
    const { title, description } = req.body as {
        title: string;
        description: string;
    };

    try {
        const response = await db.one(
            "INSERT INTO feeds(title, description) VALUES($1, $2) RETURNING id",
            [title, description]
        );

        res.redirect(`/feed/${response.id}`);
        // res.status(201).send({ message: "Feed created successfully", id  });
    } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Internal server error" });
    }
});
app.post(`/api/${apiVersion}/feed/:id`, async (req: Request, res: Response) => {
    const id = req.params.id;

    if (req.body.delete) {
        try {
            await db.none("DELETE FROM websites WHERE feed_id = $1", [id]);
            await db.none("DELETE FROM feeds WHERE id = $1", [id]);
            res.redirect(`/`);
        } catch (error) {
            console.log(error);
            res.status(500).send({ message: "Internal server error" });
        }
    }
});
app.get(
    "/website/:id",
    async (req: Request, res: Response, next: NextFunction) => {
        if (!req.params.id || req.params.id === "") {
            next(new Error("Website ID is required"));
            return;
        }

        try {
            const website: Website = await db.one(
                "SELECT * FROM websites WHERE id = $1",
                [req.params.id]
            );
            const feed: Feed = await db.one(
                "SELECT * FROM feeds WHERE id = $1",
                [website.feed_id]
            );
            const posts: Post[] = await db.any(
                "SELECT * FROM posts WHERE website_id = $1",
                [website.id]
            );
            posts.forEach((post) => {
                if (post.date) {
                    post.date = preferredDateFormatting.format(
                        new Date(post.date)
                    );
                }
            });
            res.render("website", { feed, website, posts });
        } catch (error) {
            next(new Error((error as Error).message));
        }
    }
);
app.get(
    "/website/:id/wizard",
    async (req: Request, res: Response, next: NextFunction) => {
        if (!req.params.id || req.params.id === "") {
            next(new Error("Website ID is required"));
            return;
        }

        try {
            const website: Website = await db.one(
                "SELECT * FROM websites WHERE id = $1",
                [req.params.id]
            );

            const feed: Feed = await db.one(
                "SELECT * FROM feeds WHERE id = $1",
                [website.feed_id]
            );

            const wizardCodeInject = `
            <script>
                document.addEventListener("DOMContentLoaded", () => {
                    document.body.addEventListener("click", (event) => {
                        event.preventDefault();

                        const path = event.composedPath();
                        const target = path[0];

                        const pathSelector = path.reverse().map((element, i) => {
                            if (element.id && i === path.length - 1) {
                                return element.tagName + "#" + element.id;
                            }
                            if (element.className) {
                                return element.tagName + "." + element.className.split(" ").join(".");
                            }
                            if (element.tagName && element.tagName !== "HTML" && element.tagName !== "HEAD" && element.tagName !== "BODY") {
                                return element.tagName.toLowerCase();
                            }

                            return "";
                        }).join(" ").trim();

                        window.parent.postMessage({ selectedElementPath: pathSelector }, "*");
                    });
                });
            </script>
            <style>
                *:hover:not(:has(*:hover)) {
                    outline: 1px solid red !important;
                }
            </style>
            `

            if (!website.latest_html) {
                throw new Error("No HTML found for website");
            }

            // Inject the wizard code into the HTML
            website.latest_html = website.latest_html?.replace("</head>", `${wizardCodeInject}</head>`);

            res.render("website-wizard", { website, feed });
        } catch (error) {
            next(new Error((error as Error).message));
        }
    }
);

app.post(`/api/${apiVersion}/website/:id/wizard`, async (req: Request, res: Response) => {
    console.log(req.body);
    const websiteId = req.params.id;
    const { post_selector, title_selector, url_selector, content_selector, date_selector, author_selector } = req.body;

    const selectors: WebsiteSelectors = {
        post_selector,
        title_selector,
        url_selector,
        content_selector,
        date_selector,
        author_selector,
    };

    try {

        const website: Website = await db.one(
            "SELECT * FROM websites WHERE id = $1",
            [websiteId]
        );

        if (!website.latest_html) {
            throw new Error("No HTML found for website");
        }

        const $ = cheerio.load(website.latest_html);
        const posts: Post[] = await getPostDataForSelectors($, selectors, website.url);

        posts.forEach((post) => {
            if (post.date) {
                post.date = preferredDateFormatting.format(
                    new Date(post.date)
                );
            }
        });

        console.log(posts)

        res.render("partials/posts/website-post-list", { website, posts });
    } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Internal server error" });
    }
});

app.post(`/api/${apiVersion}/website`, async (req: Request, res: Response) => {
    const { url, feedId } = req.body as { url: string; feedId: string };

    const formattedUrl = formatURL(url);

    try {
        const response = await db.one(
            "INSERT INTO websites(url, feed_id) VALUES($1, $2) RETURNING id",
            [formattedUrl, feedId]
        );

        await initialCrawler.run([
            {
                url: formattedUrl,
                label: response.id,
                userData: { label: response.id, useLLM: true },
            },
        ]);

        res.redirect(`/website/${response.id}`);
    } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Internal server error" });
    }
});

app.post(
    `/api/${apiVersion}/website/:id`,
    async (req: Request, res: Response) => {
        const websiteId = req.params.id;
        try {
            if (req.body.delete) {
                const response = await db.one(
                    "SELECT feed_id FROM websites WHERE id = $1",
                    [websiteId]
                );
                if (!response) {
                    res.status(404).send({ message: "Website not found" });
                    return;
                }

                await db.none("DELETE FROM posts WHERE website_id = $1", [
                    websiteId,
                ]);
                await db.none("DELETE FROM websites WHERE id = $1", [
                    websiteId,
                ]);

                res.redirect(`/feed/${response.feed_id}`);
            } else {
                const website: Website = await db.one(
                    "SELECT * FROM websites WHERE id = $1",
                    [req.params.id]
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
                };

                await db.none("DELETE FROM posts WHERE website_id = $1", [
                    website.id,
                ]);

                if (website.latest_html) {
                    const $ = cheerio.load(website.latest_html);
                    const posts: Post[] = await getPostDataForSelectors($, selectors, website.url);
                    await insertWebsitePosts(posts, website.id);
                } else {
                    await initialCrawler.run([
                        {
                            url: website.url,
                            userData: { selectors, label: website.id },
                        },
                    ]);
                }

                res.redirect(`/website/${website.id}`);
            }
        } catch (error) {
            console.log(error);
            res.status(500).send({ message: "Internal server error" });
        }
    }
);

// cron.schedule("*/10 * * * *", async () => {
//     console.log("Running cron job every 10 minutes");
//     const websitesToCrawl: Website[] = await db.any("SELECT * FROM websites WHERE last_crawled IS NULL OR last_crawled < NOW() - INTERVAL '1 day'");
//     console.log(websitesToCrawl);
// })

app.listen(port, () => {
    console.log(`Server is up and running on port ${port}`);
});
