export interface Feed {
    id: string;
    title: string;
    description?: string;
    previewLinks?: string[];
}

export interface WebsiteSelectors {
    post_selector?: string;
    title_selector?: string;
    url_selector?: string;
    content_selector?: string;
    date_selector?: string;
    author_selector?: string;
    date_regex?: string;
    author_regex?: string;
}

export interface Website extends WebsiteSelectors {
    id: string;
    feed_id: string;
    url: string;
    favicon_url?: string;
    latest_html?: string;
    last_crawled?: Date;
}

export interface Post {
    website_id?: string;
    title?: string;
    url?: string;
    content?: string;
    date?: string | undefined;
    dateFormatted?: string;
    author?: string;
}