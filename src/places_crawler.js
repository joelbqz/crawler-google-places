const Apify = require('apify');
const Globalize = require('globalize');

const DEFAULT_CRAWLER_LOCALIZATION = ['en', 'cs'];

Globalize.load(require('cldr-data').entireSupplemental());
Globalize.load(require('cldr-data').entireMainFor(...DEFAULT_CRAWLER_LOCALIZATION));

const { sleep, log } = Apify.utils;
const { injectJQuery, blockRequests } = Apify.utils.puppeteer;
const infiniteScroll = require('./infinite_scroll');
const { MAX_PAGE_RETRIES, DEFAULT_TIMEOUT, PLACE_TITLE_SEL } = require('./consts');
const { enqueueAllPlaceDetails } = require('./enqueue_places_crawler');
const { saveHTML, saveScreenshot, waitForGoogleMapLoader, parseReviewFromResponseBody } = require('./utils');

/**
 * This is the worst part - parsing data from place detail
 * @param page
 */
const extractPlaceDetail = async (page, request, searchString, includeReviews, includeImages, includeHistogram, includeOpeningHours, includePeopleAlsoSearch, proxyConfig) => {
    // Extract basic information
    await waitForGoogleMapLoader(page);
    await page.waitForSelector(PLACE_TITLE_SEL, { timeout: DEFAULT_TIMEOUT });
    const detail = await page.evaluate((placeTitleSel) => {
        return {
            title: $(placeTitleSel).text().trim(),
            totalScore: $('span.section-star-display').eq(0).text().trim(),
            categoryName: $('[jsaction="pane.rating.category"]').text().trim(),
            address: $('[data-section-id="ad"] .widget-pane-link').text().trim(),
            plusCode: $('[data-section-id="ol"] .widget-pane-link').text().trim(),
            website: $('[data-section-id="ap"]').length ? $('[data-section-id="ap"]').eq('0').text().trim() : null,
            phone: $('[data-section-id="pn0"].section-info-speak-numeral').length
                ? $('[data-section-id="pn0"].section-info-speak-numeral').attr('data-href').replace('tel:', '')
                : null,
        };
    }, PLACE_TITLE_SEL);

    // Add info from listing page
    const { userData } = request;
    detail.shownAsAd = userData.shownAsAd;
    detail.rank = userData.rank;
    detail.placeId = request.uniqueKey;

    // Extract gps from URL
    // We need to URL will be change, it happened asynchronously
    await page.waitForFunction(() => window.location.href.includes('/place/'));
    const url = page.url();
    detail.url = url;
    const [fullMatch, latMatch, lngMatch] = url.match(/!3d(.*)!4d(.*)/);
    if (latMatch && lngMatch) {
        detail.location = { lat: parseFloat(latMatch), lng: parseFloat(lngMatch) };
    }

    // Include search string
    detail.searchString = searchString;

    // Extract histogram for popular times
    if (includeHistogram) {
        const histogramSel = '.section-popular-times';
        if (await page.$(histogramSel)) {
            detail.popularTimesHistogram = await page.evaluate(() => {
                const graphs = {};
                const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
                // Extract all days graphs
                $('.section-popular-times-graph').each(function (i) {
                    const day = days[i];
                    graphs[day] = [];
                    let graphStartFromHour;
                    // Finds where x axis starts
                    $(this).find('.section-popular-times-label').each(function (labelIndex) {
                        if (graphStartFromHour) return;
                        const hourText = $(this).text().trim();
                        graphStartFromHour = hourText.includes('p')
                            ? 12 + (parseInt(hourText) - labelIndex)
                            : parseInt(hourText) - labelIndex;
                    });
                    // Finds values from y axis
                    $(this).find('.section-popular-times-bar').each(function (barIndex) {
                        const occupancyMatch = $(this).attr('aria-label').match(/\d+(\s+)?%/);
                        if (occupancyMatch && occupancyMatch.length) {
                            const maybeHour = graphStartFromHour + barIndex;
                            graphs[day].push({
                                hour: maybeHour > 24 ? maybeHour - 24 : maybeHour,
                                occupancyPercent: parseInt(occupancyMatch[0]),
                            });
                        }
                    });
                });
                return graphs;
            });
        }
    }

    // Extract opening hours
    if (includeOpeningHours) {
        const openingHoursSel = '.section-open-hours-container.section-open-hours-container-hoverable';
        if (await page.$(openingHoursSel)) {
            const openingHoursText = await page.evaluate(() => {
                return $('.section-open-hours-container.section-open-hours-container-hoverable').attr('aria-label');
            });
            const openingHours = openingHoursText.split(',');
            if (openingHours.length) {
                detail.openingHours = openingHours.map((line) => {
                    let [match, day, hours] = line.match(/(\S+)\s(.*)/);
                    hours = hours.split('.')[0];
                    return {day, hours};
                })
            }
        }
    }

    // Extract "People also search"
    const peopleSearchContainer = await page.$('.section-carousel-scroll-container');
    if (peopleSearchContainer && includePeopleAlsoSearch) {
        detail.peopleAlsoSearch = [];
        const cardSel = 'button[class$="card"]';
        const cards = await peopleSearchContainer.$$(cardSel);
        for (let i = 0;i < cards.length; i++) {
            const searchResult = await page.evaluate((index, sel) => {
                const card = $(sel).eq(index);
                return {
                    title: card.find('div[class$="title"]').text().trim(),
                    totalScore: card.find('span[class$="rating"]').text().trim(),
                }
            }, i, cardSel);
            // For some reason, puppeteer click doesn't work here
            await Promise.all([
                page.evaluate((button, index) => {
                    $(button).eq(index).click();
                }, cardSel, i),
                page.waitForNavigation({ waitUntil: [ 'domcontentloaded', 'networkidle2' ] }),
            ]);
            searchResult.url = await page.url();
            detail.peopleAlsoSearch.push(searchResult);
            await Promise.all([
                page.goBack({ waitUntil: [ 'domcontentloaded', 'networkidle2' ] }),
                waitForGoogleMapLoader(page)
            ]);
        }
    }

    // Extract reviews
    const reviewsButtonSel = 'button[jsaction="pane.reviewChart.moreReviews"]';
    if (detail.totalScore) {
        const { reviewsCountText, localization } = await page.evaluate((selector) => {
            let numberReviewsText = $(selector).text().trim();
            const number = numberReviewsText.match(/\d*/g);
            const formatNumber = number.reduce((total,current)=> total+current)
            return {
                reviewsCountText: number ? formatNumber : null,
                localization: navigator.language.slice(0,2),
            }
        }, reviewsButtonSel);
        let globalParser;
        try {
            globalParser = Globalize(localization);
        } catch (e) {
            throw new Error(`Can not find localization for ${localization}, try to use different proxy IP.`);
        }
        detail.totalScore = globalParser.numberParser({round:'floor'})(detail.totalScore);
        detail.reviewsCount = reviewsCountText ? globalParser.numberParser({round:'truncate'})(reviewsCountText) : null;
        // If we find consent dialog, close it!
        if (await page.$('.widget-consent-dialog')) {
            await page.click('.widget-consent-dialog .widget-consent-button-later');
        }
        // Get all reviews
        if (includeReviews) {
            detail.reviews = [];
            await page.waitForSelector(reviewsButtonSel);
            await page.click(reviewsButtonSel);
            await page.waitForSelector('.section-star-display', { timeout: DEFAULT_TIMEOUT });
            await sleep(5000);

            // Sort reviews by newest
            await page.click('.section-dropdown-menu-button-caption');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');

            const reviewsResponse = await page.waitForResponse(response => response.url().includes('preview/review/listentitiesreviews'));
            await sleep(1000);

            let reviewResponseBody = await reviewsResponse.buffer();
            const reviews = parseReviewFromResponseBody(reviewResponseBody);
            detail.reviews.push(...reviews);
            let reviewUrl = reviewsResponse.url();
            const increaseLimitInUrl = (url) => {
                const numberString = reviewUrl.match(/\!1i(\d+)/)[1];
                const number = parseInt(numberString)
                return url.replace(/\!1i\d+/, `!1i${number+10}`);
            };

            while(true) {
                reviewUrl = increaseLimitInUrl(reviewUrl);
                // Request in browser context to use proxy as in brows
                const responseBody = await page.evaluate(async (url) => {
                    const response = await fetch(url);
                    return await response.text();
                }, reviewUrl);
                const reviews = parseReviewFromResponseBody(responseBody);
                if (reviews.length === 0) break;
                detail.reviews.push(...reviews);
            }

            await page.click('button[jsaction*=back]');
        }  else {
            log.info(`Skipping reviews scraping for url: ${page.url()}`)
        }
    }

    // Extract place images
    if (includeImages) {
        await page.waitForSelector(PLACE_TITLE_SEL, { timeout: DEFAULT_TIMEOUT });
        const imagesButtonSel = '.section-image-pack-image-container';
        const imagesButton = await page.$(imagesButtonSel);
        if (imagesButton) {
            await sleep(2000);
            await imagesButton.click();
            await infiniteScroll(page, 99999999999, '.section-scrollbox.scrollable-y', 'images list');
            detail.imageUrls = await page.evaluate(() => {
                const urls = [];
                $('.gallery-image-high-res').each(function () {
                    const urlMatch = $(this).attr('style').match(/url\("(.*)"\)/);
                    if (!urlMatch) return;
                    let imageUrl = urlMatch[1];
                    if (imageUrl[0] === '/') imageUrl = `https:${imageUrl}`;
                    urls.push(imageUrl);
                });
                return urls;
            });
        }
    } else {
        log.info(`Skipping images scraping for url: ${page.url()}`)
    }

    return detail;
};

/**
 * Save screen and HTML content to debug page
 */
const saveScreenForDebug = async (reques, page) => {
    await saveScreenshot
};

/**
 * Method to set up crawler to get all place details and save them to default dataset
 * @param launchPuppeteerOptions
 * @param requestQueue
 * @param maxCrawledPlaces
 * @return {Apify.PuppeteerCrawler}
 */
const setUpCrawler = (launchPuppeteerOptions, requestQueue, maxCrawledPlaces, input) => {
    const { includeReviews, includeImages, includeHistogram, includeOpeningHours, includePeopleAlsoSearch } = input;
    const crawlerOpts = {
        launchPuppeteerOptions,
        requestQueue,
        maxRequestRetries: MAX_PAGE_RETRIES, // Sometimes page can failed because of blocking proxy IP by Google
        retireInstanceAfterRequestCount: 100,
        handlePageTimeoutSecs: 30 * 60, // long timeout, because of long infinite scroll
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: 1,
        },
        maxConcurrency: Apify.isAtHome() ? undefined : 1,
    };
    return new Apify.PuppeteerCrawler({
        ...crawlerOpts,
        gotoFunction: async ({ request, page }) => {
            await page._client.send('Emulation.clearDeviceMetricsOverride');
            await blockRequests(page, {
                urlPatterns: ['/maps/vt/', '/earth/BulkMetadata/', 'googleusercontent.com'],
            });
            await page.goto(request.url, { timeout: 60000 });
        },
        handlePageFunction: async ({ request, page, puppeteerPool }) => {
            const { label, searchString } = request.userData;

            log.info(`Open ${request.url} with label: ${label}`);
            await injectJQuery(page);

            try {
                // Check if Google shows captcha
                if (await page.$('form#captcha-form')) {
                    console.log('******\nGoogle shows captcha. This browser will be retired.\n******');
                    throw new Error('Needs to fill captcha!');
                }
                if (label === 'startUrl') {
                    log.info(`Start enqueuing places details for search: ${searchString}`);
                    await enqueueAllPlaceDetails(page, searchString, requestQueue, maxCrawledPlaces, request);
                    log.info('Enqueuing places finished.');
                } else {
                    // Get data for place and save it to dataset
                    log.info(`Extracting details from place url ${page.url()}`);
                    const placeDetail = await extractPlaceDetail(page, request, searchString, includeReviews, includeImages,
                        includeHistogram, includeOpeningHours, includePeopleAlsoSearch, launchPuppeteerOptions.proxyConfig);
                    await Apify.pushData(placeDetail);
                    log.info(`Finished place url ${placeDetail.url}`);
                }
            } catch(err) {
                // This issue can happen, mostly because proxy IP was blocked by google
                // Let's refresh IP using browser refresh.
                if (log.getLevel() === log.LEVELS.DEBUG) {
                    await saveHTML(page, `${request.id}.html`);
                    await saveScreenshot(page, `${request.id}.png`);
                }
                await puppeteerPool.retire(page.browser());
                if (request.retryCount < MAX_PAGE_RETRIES && log.getLevel() !== log.LEVELS.DEBUG) {
                    // This fix to not show stack trace in log for retired requests, but we should handle this on SDK
                    err.stack = 'Stack trace was omitted for retires requests. Set up debug mode to see it.';
                }
                throw err;
            }
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            // This function is called when crawling of a request failed too many time
            const defaultStore = await Apify.openKeyValueStore();
            await Apify.pushData({
                '#url': request.url,
                '#succeeded': false,
                '#errors': request.errorMessages,
                '#debugInfo': Apify.utils.createRequestDebugInfo(request),
                '#debugFiles': {
                    html: defaultStore.getPublicUrl(`${request.id}.html`),
                    screen: defaultStore.getPublicUrl(`${request.id}.png`),
                }
            });
            log.exception(error, `Page ${request.url} failed ${MAX_PAGE_RETRIES} times! It will not be retired. Check debug fields in dataset to find the issue.`)
        },
    });
};

module.exports = { setUpCrawler };
