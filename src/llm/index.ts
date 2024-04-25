import OpenAI from "openai";
import * as cheerio from "cheerio";
import { getDataForSelector } from "../parser";
import { type WebsiteSelectors } from "../types";

if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export const parseSelectorsFromLLM = (responseStringWithPotentialJson: string) => {
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

export const getLLMRegexSuggestion = async (
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

export const getLLMSelectors = async (
    body: string,
): Promise<WebsiteSelectors> => {
    let selectors: WebsiteSelectors = {};
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
        console.error(JSON.stringify(answer));
    } else {
        selectors = parseSelectorsFromLLM(answer.choices[0].message.content);
    }

    return selectors;
};