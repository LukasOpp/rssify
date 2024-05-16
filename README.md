# rssify

Web app for managing your own feeds of website posts. Like RSS but without RSS.

## Live Demo
Running at http://s0k4w4w.5.75.242.145.sslip.io

## Current Caveats / Improvements
- Initial crawl a bit slow
- Current crawler deployment via Hetzner without proxy results in 403s on many popular sites
- No history crawling
(somewhat easy with Crawlee)
- No user management 
  - It would be nice to have Feed voting / saving mechanism
- Would be good to get away from OpenAI
- URL autocompletion would be nice
- Saving canonical parsing configs for URLs would be nice
- No mobile layout

## Installation
1. Set up a Postgres instance and OpenAI API key and create a `.env`
2. Run `npm i`
3. Run `npm run dev`
