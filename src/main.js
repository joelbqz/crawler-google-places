const Apify = require('apify');
const placesCrawler = require('./places_crawler');
const resultJsonSchema = require('./result_item_schema');
const _ = require('lodash');
const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    const { searchString, searchStringsArray, proxyConfig, lat, lng, maxCrawledPlaces, regularTestRun,
        includeReviews = true, includeImages = true, includeHistogram = true,
        includeOpeningHours = true, walker } = input;

    if (!searchString && !searchStringsArray) throw new Error('Attribute searchString or searchStringsArray is missing in input.');
    if (proxyConfig && proxyConfig.apifyProxyGroups
        && (proxyConfig.apifyProxyGroups.includes('GOOGLESERP') || proxyConfig.apifyProxyGroups.includes('GOOGLE_SERP'))) {
        throw new Error('It is not possible to crawl google places with GOOGLE SERP proxy group. Please use a different one and rerun crawler.');
    }

    log.info('Scraping Google Places for search string:', searchString);

    const startRequests = [];
    let startUrlSearch = 'https://www.google.com/maps/search/';
    if (lat || lng) {
        const { zoom = 10 } = input;
        if (!lat || !lng) throw new Error('You have to defined lat and lng!');
        startUrlSearch = `https://www.google.com/maps/@${lat},${lng},${zoom}z/search`;
    }

    if (walker && searchString) {
        const { zoom, step, bounds } = walker;
        const { northeast, southwest } = bounds;
        log.info(`Using walker mode, generating pieces of map to walk with step ${step}, zoom ${step} and bounds ${JSON.stringify(bounds)}.`);
        /**
         * The hidden feature, with walker you can search business in specific square on map.
         */
        // Generate URLs to walk
        for (let walkerLng = northeast.lng; walkerLng >= southwest.lng; walkerLng = walkerLng - step) {
            for (let walkerLat = northeast.lat; walkerLat >= southwest.lat; walkerLat = walkerLat - step) {
                startRequests.push({
                    url: `https://www.google.com/maps/@${walkerLat},${walkerLng},${zoom}z/search`,
                    userData: { label: 'startUrl', searchString },
                });
            }
        }
    } else if (searchString || searchStringsArray) {
        if (searchStringsArray && !_.isArray(searchStringsArray)) throw new Error('Attribute searchStringsArray has to be an array.');
        const searches = searchStringsArray || [searchString];
        for (const search of searches) {
            /**
             * User can use place_id:<Google place ID> as search query
             * TODO: Move place id to separate fields, once we have dependent fields. Than user can fill placeId or search query.
             */
            if (search.includes('place_id:')) {
                log.info(`Place ID found in search query. We will extract data from ${search}.`);
                const placeUrl = `https://www.google.com/maps/place/?q=${search.replace(/\s+/g, '')}`;
                startRequests.push({ url: placeUrl, uniqueKey: search, userData: { label: 'placeDetail' } });
            } else {
                startRequests.push({ url: startUrlSearch, uniqueKey: search, userData: { label: 'startUrl', searchString: search } });
            }
        }
    }

    log.info('Start urls are', startRequests);
    const requestQueue = await Apify.openRequestQueue();

    for (const request of startRequests) {
        await requestQueue.addRequest(request);
    }

    const launchPuppeteerOptions = {};
    if (proxyConfig) Object.assign(launchPuppeteerOptions, proxyConfig);

    // Create and run crawler
    const crawler = placesCrawler.setUpCrawler(launchPuppeteerOptions, requestQueue,
        maxCrawledPlaces, input);
    await crawler.run();

    if (regularTestRun) {
        const { defaultDatasetId: datasetId } = Apify.getEnv();
        await Apify.call('drobnikj/check-crawler-results', {
            datasetId,
            options: {
                minOutputtedPages: 5,
                jsonSchema: resultJsonSchema,
                notifyTo: 'jakub.drobnik@apify.com',
            },
        });
    }

    log.info('Done!');
});
