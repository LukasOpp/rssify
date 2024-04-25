import * as cheerio from "cheerio";
import { type Post, type WebsiteSelectors } from "../types";

export const getDataForSelector = (
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

export const getPostDataForSelectors = async (
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
            if (!(title || url || content || date || author)) {
                return null;
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