-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS feeds (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    title            text NOT NULL,
    description     text
);

CREATE TABLE IF NOT EXISTS websites (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    feed_id             uuid NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
    url                 text NOT NULL,
    favicon_url         text,
    post_selector       text,
    title_selector      text,
    url_selector        text,
    content_selector    text,
    date_selector       text,
    author_selector     text,
    date_regex          text,
    author_regex        text,
    latest_html         text,
    last_crawled        timestamptz
);

CREATE TABLE IF NOT EXISTS posts (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    website_id            uuid REFERENCES websites (id) ON DELETE CASCADE,
    title                 text,
    url                   text,
    content               text,
    date                  text,
    author                text,
    date_crawled          timestamptz
);
