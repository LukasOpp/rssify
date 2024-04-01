CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS feeds (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    title            text NOT NULL,
    description     text
);

CREATE TABLE IF NOT EXISTS websites (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    feed_id             uuid NOT NULL REFERENCES feeds (id),
    url                 text NOT NULL,
    title_selector      text,
    url_selector        text,
    content_selector    text,
    date_selector       text,
    author_selector     text,
    latest_html         text
);

CREATE TABLE IF NOT EXISTS posts (
    source_website_id     text PRIMARY KEY,
    title                 text,
    url                   text,
    content               text,
    date                  text,
    author                text
);

-- DROP TABLE feeds CASCADE;
-- DROP TABLE websites CASCADE;
-- DROP TABLE posts CASCADE;