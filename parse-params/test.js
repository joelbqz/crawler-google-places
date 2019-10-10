/**
 * http://blog.themillhousegroup.com/2016/08/deep-diving-into-google-pb-embedded-map.html
 * https://stackoverflow.com/questions/18413193/how-do-i-decode-encode-the-url-parameters-for-the-new-google-maps/34275131#34275131
 * https://gist.github.com/jeteon/e71fa21c1feb48fe4b5eeec045229a0c
 */

'use strict';

/**
 * Basic code to parse the values in the "data" attribute in a Google Maps URL to an Array.
 * There will likely still be some work to do to interpret the resulting Array.
 *
 * Based on information from:
 *  http://stackoverflow.com/a/34275131/1852838
 *  http://stackoverflow.com/a/24662610/1852838
 */

const util = require('util');

// Data string to be parsed
var str = '!3m1!4b1!4m20!4m19!1m5!1m1!1s0x1e955fe737bd22e5:0xf5b813675e007ba8!2m2!1d28.3023579!2d-25.7297871!1m5!1m1!1s0x1e955e5c875906fd:0xa65176214cdebc80!2m2!1d28.3374283!2d-25.7657075!1m5!1m1!1s0x1e9560c06dba5b73:0x57122f60632be1a1!2m2!1d28.274954!2d-25.7832822!3e0';
// var str = '!4m9!1m3!1d305211.4043589051!2d16.905817894446624!3d50.130505507300406!2m0!3m2!1i2304!2i716!4f13.1!7i20!8i0!10b1!12m16!2m3!5m1!6e2!20e3!6m9!4b1!7i1!23b1!26i1!27i1!41i2!45b1!49b1!63m0!10b1!16b1!19m4!2m3!1i360!2i120!4i8!20m57!2m2!1i203!2i100!3m2!2i4!5b1!6m6!1m2!1i86!2i86!1m2!1i408!2i200!7m42!1m3!1e1!2b0!3e3!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e9!2b1!3e2!1m3!1e10!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e4!2b1!4b1!9b0!22m6!1sQPVrXLmoJYzD6AStwKOYAQ%3A54!2s1i%3A0%2Ct%3A20588%2Cp%3AQPVrXLmoJYzD6AStwKOYAQ%3A54!4m1!2i20588!7e81!12e3!24m27!2b1!5m5!2b1!3b1!5b1!6b1!7b0!10m1!8e3!14m1!3b1!17b1!20m2!1e3!1e6!24b1!25b1!26b1!30m1!2b1!36b1!43b1!52b1!55b0!56m2!1b1!3b0!26m4!2m3!1i80!2i92!4i8!30m28!1m6!1m2!1i0!2i0!2m2!1i458!2i716!1m6!1m2!1i2254!2i0!2m2!1i2304!2i716!1m6!1m2!1i0!2i0!2m2!1i2304!2i20!1m6!1m2!1i0!2i696!2m2!1i2304!2i716!31b1!34m7!3b1!4b1!6b1!8m3!1b1!2b1!3b1!37m1!1e81!42b1!46m1!1e9!47m0!49m1!3b1!50m12!1m11!2m7!1u2!4sTop+rated!5e1!9s0ahUKEwiOtof45MfgAhWMIZoKHS3gCBMQ_KkBCPIFKBY!10m2!2m1!1e1!3m1!1u2!4BIAE!59BQ2dBd0Fn';

var parts = str.split('!').filter(function(s) { return s.length > 0; }),
    root = [],                      // Root elemet
    curr = root,                    // Current array element being appended to
    m_stack = [root,],              // Stack of "m" elements
    m_count = [parts.length,];      // Number of elements to put under each level

parts.forEach(function(el) {
    var kind = el.substr(1, 1),
        value = el.substr(2);

    // Decrement all the m_counts
    for (var i = 0; i < m_count.length; i++) {
        m_count[i]--;
    }

    if (kind === 'm') {            // Add a new array to capture coming values
        var new_arr = [];
        m_count.push(value);
        curr.push(new_arr);
        m_stack.push(new_arr);
        curr = new_arr;
    }
    else {
        if (kind == 'b') {                                    // Assuming these are boolean
            curr.push(value == '1');
        }
        else if (kind == 'd' || kind == 'f') {                // Float or double
            curr.push(parseFloat(value));
        }
        else if (kind == 'i' || kind == 'u' || kind == 'e') { // Integer, unsigned or enum as int
            curr.push(parseInt(value));
        }
        else if (kind === 's') {

        }
        else {                                                // Store anything else as a string
            curr.push(value);
        }
    }

    // Pop off all the arrays that have their values already
    while (m_count[m_count.length - 1] === 0) {
        m_stack.pop();
        m_count.pop();
        curr = m_stack[m_stack.length - 1];
    }
});

console.log(JSON.stringify(root));
