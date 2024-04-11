import express, { Request, Response, Express } from "express";
import pgPromise from "pg-promise";
// import cron from "node-cron";
import dotenv from "dotenv";
import {
    // PlaywrightCrawler,
    // ProxyConfiguration,
    Dataset,
    CheerioCrawler,
} from "crawlee";
import * as cheerio from "cheerio";
import { formatURL } from "./js/helpers";
import OpenAI from "openai";
import { log } from "console";

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
    date_regex?: string;
    author_regex?: string;
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

const getDataForSelector = (
    parent: cheerio.Cheerio<cheerio.Element>,
    selector: string
): string | undefined => {
    const attribute = selector.match(/.*\[(.*?)\]/)?.[1];
    const selectorWithoutAttribute = selector.replace(/\[.*\]/, "");

    if (attribute) {
        return parent.find(selectorWithoutAttribute).first().attr(attribute);
    } else {
        return parent.find(selector).first().text();
    }
};

const parseSelectorsFromLLM = (responseStringWithPotentialJson: string) => {
    try {
        const indexOfJSONOpening = responseStringWithPotentialJson.indexOf("{");
        const indexOfJSONClosing = responseStringWithPotentialJson.lastIndexOf("}");
        
        const potentialJson = responseStringWithPotentialJson.slice(indexOfJSONOpening, indexOfJSONClosing + 1);
        if (!potentialJson) {
            throw new Error("No JSON found in OpenAI response");
        }
        const answerJson = JSON.parse(potentialJson);

        return {
            post_selector: answerJson.post_selector,
            title_selector: answerJson.title_selector,
            url_selector: answerJson.url_selector,
            content_selector: answerJson.content_selector,
            date_selector: answerJson.date_selector,
            author_selector: answerJson.author_selector,
            date_regex: answerJson.date_regex,
            author_regex: answerJson.author_regex,
        };
    } catch (error) {
        console.error({
            context: "OpenAI response",
            error: JSON.stringify(error),
            answer: responseStringWithPotentialJson,
        });
    }

    return {};
}

const getLLMRegexSuggestion = async (
    $: cheerio.CheerioAPI,
    postSelector: string,
    currentSelectorType: 'date' | 'author',
    currentSelector: string,
): Promise<string | null> => {
    const postElement = $(postSelector) as cheerio.Cheerio<cheerio.Element>;

    try {
        const selectedText = getDataForSelector(postElement, currentSelector);
    
        if (!selectedText) {
            throw new Error("No text found for selected element");
        }

        const answer = await openai.chat.completions.create({
            model: "gpt-4-turbo-preview",
            messages: [
                {
                    content: `give me a regex that would match the ${currentSelectorType} in matching group 1 instead of matching group 0 in the following text, but respond to me only as a JSON with keys "date_regex" or "author_regex":\n\n"${selectedText}"`,
                    role: "system",
                },
            ],
        });

        if (!answer.choices[0].message.content) {
            throw new Error(JSON.stringify(answer));
        }

        const regex = parseSelectorsFromLLM(answer.choices[0].message.content)[`${currentSelectorType}_regex`];

        return regex;
    } catch (error) {
        console.error(error);
    }

    return null;
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
            const title = selectors.title_selector ? getDataForSelector(
                postElement,
                selectors.title_selector
            ) : undefined;
            let url = selectors.url_selector ? getDataForSelector(postElement, selectors.url_selector) : undefined;

            if (url && !url.startsWith("http")) {
                const baseUrl = new URL(origin);
                url = new URL(url, baseUrl).href;
            }
            const content = selectors.content_selector ? getDataForSelector(
                postElement,
                selectors.content_selector
            ) : undefined;

            let date = selectors.date_selector ? getDataForSelector(postElement, selectors.date_selector) : undefined;
            if (date) {
                if (selectors.date_regex) {
                    date = date.replace(/\n/g, '');
                    const regex = new RegExp(selectors.date_regex, 'm');
                    const match = date.match(regex);
                    if (match) {
                        date = match[1];
                    }
                }
                const dateObject = new Date(date);
                if (isNaN(dateObject.getTime())) {
                    date = undefined;
                } else {
                    date = dateObject.toISOString();
                }
            }

            let author = selectors.author_selector ? getDataForSelector(
                postElement,
                selectors.author_selector
            ) : undefined;
            if (author && selectors.author_regex) {
                // filter out newlines from author
                author = author.replace(/\n/g, '');
                const regex = new RegExp(selectors.author_regex, 'm');
                const match = author.match(regex);
                if (match) {
                    author = match[1];
                }
            }

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

const crawler = new CheerioCrawler({
    maxRequestRetries: 3,
    requestHandler: async ({ $, request }) => {
        try {
            const body = $("body").html() as string;

            // get all link elements with rel attribute containing "icon"
            const favicon = $("link[rel*='icon']").attr("href");
            const fullFaviconPath = favicon
                ? new URL(favicon, request.url)
                : new URL("/favicon.ico", request.url);

            let selectors: WebsiteSelectors = {};

            if (request.userData.useLLM) {
                const answer = await openai.chat.completions.create({
                    model: "gpt-4-turbo-preview",
                    messages: [
                        {
                            content: `give me the jquery selectors for post, post title, post url, post content, post date and post author for the following html, but respond to me only as a JSON with keys "post_selector", "title_selector", "url_selector", "content_selector", "date_selector" and "author_selector". make every selector except "post_selector" relative to "post_selector". it is okay to set selectors to null if you can't find anything good. please find the most explicit data, for example you should prefer timestamps over relative datetime like "3 hours ago". include attributes in the selector with brackets, not with an @. you may use jquery selectors like :contains and :first. if you are looking for either date or author and find an element that contains the data you're looking for but also contains other text, you may additionally specify a regex expression "(date|author)_regex" that would correctly match the data you're looking for. \n\n${body}`,
                            role: "system",
                        },
                    ],
                });

                if (!answer.choices[0].message.content) {
                    throw new Error(JSON.stringify(answer));
                }

                selectors = parseSelectorsFromLLM(answer.choices[0].message.content);
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
            SET latest_html = $1, 
            last_crawled = NOW(), 
            favicon_url = $2, 
            post_selector = $3,
            title_selector = $4,
            url_selector = $5,
            content_selector = $6,
            date_selector = $7,
            author_selector = $8,
            date_regex = $9,
            author_regex = $10
            WHERE id = $11`,
                [
                    $("html").html(),
                    fullFaviconPath.href,
                    selectors.post_selector,
                    selectors.title_selector,
                    selectors.url_selector,
                    selectors.content_selector,
                    selectors.date_selector,
                    selectors.author_selector,
                    selectors.date_regex,
                    selectors.author_regex,
                    request.label,
                ]
            );

            if (selectors && Object.keys(selectors).length > 0) {
                const posts = await getPostDataForSelectors(
                    $,
                    selectors,
                    request.url
                );

                if (!request.label) {
                    throw new Error("No label found in request");
                }

                await insertWebsitePosts(posts, request.label);
            }
        } catch (error) {
            Dataset.pushData({
                url: request.url,
                context: JSON.stringify(error),
            });
        }
    },
});

const preferredDateFormatting = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
});

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // support encoded bodies
app.set("view engine", "pug");
app.set("views", "./src/views");

const port = process.env.PORT || 3000;
const apiVersion = process.env.API_VERSION || "v1";


/*
    -------------------- Webpages
*/
app.get(
    "/",
    async (req: Request, res: Response): Promise<void> => {
        try {
            const feeds: Feed[] = await db.any("SELECT * FROM feeds");
            res.render("index", { feeds });
        } catch (error: unknown) {
            Dataset.pushData({
                url: "/",
                context: "Error fetching feeds",
                error: (error as Error).message,
            });
            res.status(500).send("Internal server error");
        }
    }
);

app.get(
    "/feed/:id",
    async (req: Request, res: Response): Promise<void> => {
        if (!req.params.id || req.params.id === "") {
            res.status(400).send("Feed ID is required");
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
                      "SELECT * FROM posts WHERE website_id IN ($1:csv) ORDER BY date DESC NULLS LAST",
                      [websites.map((website) => website.id)]
                  )
                : [];

            posts.forEach((post) => {
                if (post.date) {
                    post.date = preferredDateFormatting.format(
                        new Date(post.date)
                    );
                }
            });

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
            Dataset.pushData({
                url: `/feed/${req.params.id}`,
                context: "Error fetching feed",
                error: (error as Error).message,
            });
            res.status(500).send("Internal server error");
        }
    }
);

app.get(
    "/website/:id",
    async (req: Request, res: Response) => {
        if (!req.params.id || req.params.id === "") {
            res.status(400).send("Website ID is required");
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
            Dataset.pushData({
                url: "/",
                context: "Error fetching website",
                error: (error as Error).message,
            });
            res.status(500).send("Internal server error");
        }
    }
);

app.get(
    "/website/:id/wizard",
    async (req: Request, res: Response) => {
        if (!req.params.id || req.params.id === "") {
            res.status(400).send("Website ID is required");
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

                            if (element.className) {
                                return element.tagName.toLowerCase() + "." + element.className.trim().split(" ").join(".");
                            }
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
                `${wizardCodeInject}</head>`
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
            res.status(500).send("Website could not be crawled");
        }
    }
);

/*
    -------------------- API Routes
*/

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

        const feedId = response.id;

        res.redirect(`/feed/${feedId}`);
    } catch (error) {
        console.error(error);
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
            console.error(error);
            res.status(500).send({ message: "Internal server error" });
        }
    }
});

app.post(
    `/api/${apiVersion}/website/:id/wizard`,
    async (req: Request, res: Response) => {
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
                [websiteId]
            );

            if (!website.latest_html) {
                throw new Error("No HTML found for website");
            }

            const $ = cheerio.load(website.latest_html);

            let posts: Post[] = [];

            try {
                posts = await getPostDataForSelectors(
                    $,
                    selectors,
                    website.url
                );

                // let llm suggest regex for date if date selector is present but posts have no date
                if (date_selector && posts.every(post => !post.date)) {
                    const regex = await getLLMRegexSuggestion($, post_selector, 'date', date_selector);
                    if (regex) {
                        selectors.date_regex = regex;
                    }

                    posts = await getPostDataForSelectors(
                        $,
                        selectors,
                        website.url
                    );
                }

                // let llm suggest regex for author if author selector is present but posts have no author
                if (author_selector && posts.every(post => !post.author)) {
                    const regex = await getLLMRegexSuggestion($, post_selector, 'author', author_selector);
                    if (regex) {
                        selectors.author_regex = regex;
                    }

                    posts = await getPostDataForSelectors(
                        $,
                        selectors,
                        website.url
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
                    post.date = preferredDateFormatting.format(
                        new Date(post.date)
                    );
                }
            });

            res.render("partials/posts/website-post-list", { website, posts, newDateRegex: selectors.date_regex, newAuthorRegex: selectors.author_regex});
        } catch (error) {
            console.error(error);
            res.status(500).send("Server error");
        }
    }
);

app.post(`/api/${apiVersion}/website`, async (req: Request, res: Response) => {
    const { url, feedId } = req.body as { url: string; feedId: string };

    const formattedUrl = formatURL(url);

    try {
        const response = await db.one(
            "INSERT INTO websites(url, feed_id) VALUES($1, $2) RETURNING id",
            [formattedUrl, feedId]
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
            [websiteId]
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
            } else if (req.body.url) {
                const website: Website = await db.one(
                    "SELECT * FROM websites WHERE id = $1",
                    [websiteId]
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
                    [websiteId]
                );

                if (posts.length === 0) {
                    res.redirect(`/website/${websiteId}/wizard`);
                    return;
                }

                res.redirect(`/website/${websiteId}`);
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
                    ]
                );

                await db.none("DELETE FROM posts WHERE website_id = $1", [
                    website.id,
                ]);

                if (website.latest_html) {
                    const $ = cheerio.load(website.latest_html);
                    const posts: Post[] = await getPostDataForSelectors(
                        $,
                        selectors,
                        website.url
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
