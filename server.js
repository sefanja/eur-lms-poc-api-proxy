var express = require('express'),
    app = express(),
    bodyParser = require('body-parser'),
    cookieParser = require('cookie-parser'),
    _ = require('lodash'),
    async = require('async'),
    querystring = require('querystring'),
    request = require('superagent');

var port = process.env.PORT || 3000;

var authService = process.env.AUTH_SITE || "https://auth.brightspace.com";
var authCodeEndpoint = authService + "/oauth2/auth";
var tokenEndpoint = authService + "/core/connect/token";
var getRedirectUri = function(req) { return req.protocol + "://" + req.headers.host + "/callback"; };

var cookieName = "application-data-api-demo",
    cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
};

// TODO: Add time-out. Probably best to use some caching module.
// Use this caching mechanism for highly stable data only.
var cache = {};

app.set('view engine', 'ejs');
app.enable('trust proxy');
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', function(req, response) {
    response.render('index');
});

app.get('/auth', function(req, response) {
    // Authorization Request: https://tools.ietf.org/html/rfc6749#section-4.1.1
    var authCodeParams = querystring.stringify({
        response_type: "code",
        redirect_uri: getRedirectUri(req),
        client_id: process.env.CLIENT_ID,
        scope: "core:*:*",
        // Generate a secure state in production to prevent CSRF (https://tools.ietf.org/html/rfc6749#section-10.12)
        state: "f4c269a0-4a69-43c1-9405-86209c896fa0"
    });

    response.redirect(authCodeEndpoint + "?" + authCodeParams);
});

app.get('/callback', function(req, response) {
    // Authorization Response: https://tools.ietf.org/html/rfc6749#section-4.1.2
    // Validate req.query.state before continuing in production to prevent CSRF (https://tools.ietf.org/html/rfc6749#section-10.12)
    var authorizationCode = req.query.code;

    // Access Token Request: https://tools.ietf.org/html/rfc6749#section-4.1.3
    var payload = {
        grant_type: "authorization_code",
        redirect_uri: getRedirectUri(req),
        code: authorizationCode
    };

    request
        .post(tokenEndpoint)
        // Authenticate via HTTP Basic authentication scheme: https://tools.ietf.org/html/rfc6749#section-2.3.1
        .auth(process.env.CLIENT_ID, process.env.CLIENT_SECRET)
        // Using application/x-www-form-urlencoded as per https://tools.ietf.org/html/rfc6749#section-4.1.3
        .type('form')
        .send(payload)
        .end(function(err, postResponse) {
            if (err) {
                console.log('Access Token Error', err.response || err);
                response.redirect('/');
            } else {
                // Access Token Response: https://tools.ietf.org/html/rfc6749#section-4.1.4
                // We are storing the access token in a cookie for simplicity, but the user agent should never have to see it
                response.cookie(cookieName, { accessToken: postResponse.body.access_token }, cookieOptions);

                // Optionally, store the refresh token (postResponse.body.refresh_token) to a user context (https://tools.ietf.org/html/rfc6749#section-6)

                response.redirect('/data');
            }
        });
});

app.get('/data', function(req, response) {
    var access_token = req.cookies[cookieName].accessToken;

    request
        .get(process.env.HOST_URL + '/d2l/api/lp/1.10/users/whoami')
        .set('Authorization', `Bearer ${access_token}`)
        .end(function(err, result) {
            if (err) {
                var errorMessage = JSON.stringify(err, null, 2);
                console.log(errorMessage);
                response.send(`<pre>${errorMessage}</pre>`);
            } else {
                var locals = { data: JSON.stringify(JSON.parse(result.text || '{}'), null, 2) };
                response.render('data', locals);
            }
        });
});

/*
 * Simulate an upsert of a course offering from the SIS.
 * We should use a put etc., but this is easier for now.
 */
app.get('/upsert-courseoffering', function(req, response) {
    var access_token = req.cookies[cookieName].accessToken;

    // Would be nicer to fill this variable dynamically instead of hardcoded, but this suffices for now.
    var SisCourseOffering = {
        "Code": "sef7",
        "Name": "Sefanja's Course 7",
        "AcademicYear": 2016
    };

    upsertCourseOffering(SisCourseOffering, access_token, postResponse);

    function postResponse(err, result) {
        if (err) {
            console.log(err);
            response.send(`<pre>${err}</pre>`);
        } else {
            response.json(result);
        }
    }
});

/**
 * UpSert (update/insert) a course offering from the SIS.
 * @returns the course offering, whether untouched, updated or inserted.
 */
function upsertCourseOffering(sisCourseOffering, access_token, callback) {
    // If course offering exists: update, else: insert.
    getCourseOffering(sisCourseOffering, access_token, function(err, courseOffering) {
        if (err) return callback(err);

        if (courseOffering) {
            updateCourseOffering(courseOffering, sisCourseOffering, access_token, callback);
        } else {
            insertCourseOffering(sisCourseOffering, access_token, callback);
        }
    });
}

/**
 * Get the course offering for a given course offering from the SIS.
 * @returns the course offering or null if there is none.
 */
function getCourseOffering(sisCourseOffering, access_token, callback) {
    // Get the orgUnitType for course offerings.
    getOrgUnitType(process.env.COURSE_OFFERING_TYPE_CODE, access_token, getData);

    function getData(err, courseOfferingType) {
        if (err) return callback(err);

        var courseOfferingCode = sisCourseOffering.Code + '-' + (sisCourseOffering.AcademicYear % 1000);
        var url = process.env.HOST_URL + process.env.LP_PATH
            + 'orgstructure/?orgUnitType=' + encodeURIComponent(getId(courseOfferingType))
            + '&orgUnitCode=' + encodeURIComponent(courseOfferingCode);

        // Multiple results are possible since orgUnitCodes are not unique and are matched as a substring.
        getPaginated(url, access_token, function(err, courseOfferings) {
            if (err) return callback(err);
            // Narrow the results down to one exact match.
            getExactMatch(courseOfferings, {Code: courseOfferingCode}, callback);
        });
    }
}

/**
 * Insert a new course offering from the SIS.
 * @returns the newly created course offering.
 */
function insertCourseOffering(sisCourseOffering, access_token, callback) {
    async.waterfall([
        // Get or create the required course template for this course offering.
        function(callback) {
            getCourseTemplate(sisCourseOffering, access_token, function(err, courseTemplate) {
                if (err) return callback(err);

                if (!courseTemplate) {
                    insertCourseTemplate(sisCourseOffering, access_token, callback);
                } else {
                    callback(null, courseTemplate);
                }
            });
        },
        // Get or create the required semester for this course offering.
        function(courseTemplate, callback) {
            getSemester(sisCourseOffering, access_token, function(err, semester) {
                if (err) return callback(err);

                if (!semester) {
                    insertSemester(sisCourseOffering, access_token, function(err, semester) {
                        callback(err, {
                            semester: semester,
                            courseTemplate: courseTemplate
                        });
                    });
                } else {
                    callback(null, {
                        semester: semester,
                        courseTemplate: courseTemplate
                    });
                }
            });
        }
    ], function(err, results) {
        if (err) return callback(err);

        var newCourseOffering = {
            Name: sisCourseOffering.Name,
            Code: sisCourseOffering.Code + '-' + (sisCourseOffering.AcademicYear % 1000),
            Path: '/content/enforced/', // TODO: what is this?
            CourseTemplateId: getId(results.courseTemplate),
            SemesterId: getId(results.semester),
            StartDate: null,
            EndDate: null,
            LocaleId: null,
            ForceLocale: null,
            ShowAddressBook: 0
        };

        var url = process.env.HOST_URL + process.env.LP_PATH + 'courses/';
        console.log('POST ' + url);
        request
            .post(url)
            .set('Authorization', `Bearer ${access_token}`)
            .send(newCourseOffering)
            .end(function(err, result) {
                callback(err, result.body);
            });
    });
}

/**
 * Update a course offering from the SIS, if changed.
 * @returns the updated (or untouched) course offering.
 */
function updateCourseOffering(courseOffering, sisCourseOffering, access_token, callback) {
    // Leave existing fields untouched.
    var newCourseOffering = courseOffering;

    // Change the fields to be updated.
    newCourseOffering.Name = sisCourseOffering.Name;

    // Do nothing if nothing changed.
    if (_.isEqual(courseOffering, newCourseOffering)) return callback(null, courseOffering);

    // Send the update.
    var url = process.env.HOST_URL + process.env.LP_PATH + 'orgstructure/' + encodeURIComponent(getId(courseOffering));
    console.log('PUT ' + url);
    request
        .put(url)
        .set('Authorization', `Bearer ${access_token}`)
        .send(newCourseOffering)
        .end(callback);
}

/**
 * Get the course template for a given course offering from the SIS.
 * @returns the course template for the given course offering or null if there is none.
 */
function getCourseTemplate(sisCourseOffering, access_token, callback) {
    // Get the orgUnitType for course templates.
    getOrgUnitType(process.env.COURSE_TEMPLATE_TYPE_CODE, access_token, getData);

    function getData(err, courseTemplateType) {
        if (err) return callback(err);

        var courseTemplateCode = sisCourseOffering.Code;
        var url = process.env.HOST_URL + process.env.LP_PATH
            + 'orgstructure/?orgUnitType=' + encodeURIComponent(getId(courseTemplateType))
            + '&orgUnitCode=' + encodeURIComponent(courseTemplateCode);

        // Multiple results are possible since orgUnitCodes are not unique and are matched as a substring.
        getPaginated(url, access_token, function(err, courseTemplates) {
            if (err) return callback(err);
            // Narrow the results down to one exact match.
            getExactMatch(courseTemplates, {Code: courseTemplateCode}, callback);
        });
    }
}

/**
 * Insert a new course template for a given course offering from the SIS.
 * @returns the newly created course template.
 */
function insertCourseTemplate(sisCourseOffering, access_token, callback) {
    var newCourseTemplate = {
        Name: sisCourseOffering.Code + ' - Template',
        Code: sisCourseOffering.Code,
        Path: '/content/enforced/', // TODO: what is this?
        ParentOrgUnitIds: [ 6619 ] // TODO: should this be the ID of the course's faculty? If so, more API calls are needed!
    };

    var url = process.env.HOST_URL + process.env.LP_PATH + 'coursetemplates/';
    console.log('POST ' + url);
    request
        .post(url)
        .set('Authorization', `Bearer ${access_token}`)
        .send(newCourseTemplate)
        .end(function(err, result) {
            callback(err, result.body);
        });
}

/**
 * Get the semester for a given course offering from the SIS.
 * @returns the semester for the given course offering or null if there is none.
 */
function getSemester(sisCourseOffering, access_token, callback) {
    // Get the orgUnitType for course templates.
    getOrgUnitType(process.env.SEMESTER_TYPE_CODE, access_token, getData);

    function getData(err, semesterType) {
        if (err) return callback(err);

        var semesterCode = sisCourseOffering.AcademicYear % 1000;
        var url = process.env.HOST_URL + process.env.LP_PATH
            + 'orgstructure/?orgUnitType=' + encodeURIComponent(getId(semesterType))
            + '&orgUnitCode=' + encodeURIComponent(semesterCode);

        // Multiple results are possible since orgUnitCodes are not unique and are matched as a substring.
        getPaginated(url, access_token, function(err, semesters) {
            if (err) return callback(err);
            // Narrow the results down to one exact match.
            getExactMatch(semesters, {Code: semesterCode}, callback);
        });
    }
}

/**
 * Create a new semester for a given course offering from the SIS.
 * @returns the newly created semester.
 */
function insertSemester(sisCourseOffering, access_token, callback) {
    async.parallel({
        semesterType: function(callback) {
            getOrgUnitType(process.env.SEMESTER_TYPE_CODE, access_token, callback);
        },
        organization: function(callback) {
            getOrganization(process.env.EUR_NAME, access_token, callback);
        }
    },
    function(err, results) {
        if (err) return callback(err);

        var newSemester = {
            Type: getId(results.semesterType),
            Name: sisCourseOffering.AcademicYear + '-' + (sisCourseOffering.AcademicYear + 1),
            Code: sisCourseOffering.AcademicYear % 1000,
            Parents: [ getId(results.organization) ]
        };

        var url = process.env.HOST_URL + process.env.LP_PATH + 'orgstructure/';
        console.log('POST ' + url);
        request
            .post(url)
            .set('Authorization', `Bearer ${access_token}`)
            .send(newSemester)
            .end(function(err, result) {
                callback(err, result.body);
            });
    });
}

/**
 * Get an organization by its name.
 * @returns the organization for the given name or null if there is none.
 */
function getOrganization(name, access_token, callback) {
    var url = process.env.HOST_URL + process.env.LP_PATH
        + 'orgstructure/?orgUnitType=' + encodeURIComponent(process.env.ORGANIZATION_TYPE_ID)
        + '&orgUnitName=' + encodeURIComponent(name);

    // Multiple results are possible since orgUnitNames are not unique and are matched as a substring.
    getPaginated(url, access_token, function(err, organizations) {
        if (err) return callback(err);
        // Narrow the results down to one exact match.
        getExactMatch(organizations, {Name: name}, callback);
    });
}

/**
 * Get an organizational unit type by its code.
 * @returns the organizational unit type for the given code or null if there is none.
 */
function getOrgUnitType(code, access_token, callback) {
    var url = process.env.HOST_URL + process.env.LP_PATH + 'outypes/';

    // Use caching to prevent unnecessary calls.
    if (cache[url]) {
        console.log('[FROM CACHE] GET ' + url);
        handleResult(cache[url]);
    } else {
        console.log('GET ' + url);
        request
            .get(url)
            .set('Authorization', `Bearer ${access_token}`)
            .end(function(err, result) {
                if (err || !result.ok) return callback(err);
                cache[url] = result;
                handleResult(result);
            });
    }

    function handleResult(result) {
        var orgUnitType = _.find(result.body, {Code: code});
        if (!orgUnitType) {
            err = 'Error: no organizational unit type found for ' + code;
            callback(err);
        } else {
            callback(null, orgUnitType);
        }
    }
}

/**
 * Walk through all the pages to get all the items queried for.
 * @returns an array of all the items found.
 */
function getPaginated(url, access_token, callback) {
    console.log('GET ' + url);
    request
        .get(url)
        .set('Authorization', `Bearer ${access_token}`)
        .end(function(err, result) {
            handlePage(err, result, []);
        });

    function handlePage(err, result, items) {
        // Add the items from this page to the array containing all the items thus far.
        if (result && result.body && result.body.Items) {
            items = items.concat(result.body.Items);
        }

        if (err && err.status === 404) {
            return callback(null, items); // Empty items list.
        } else if (err || !result.ok) {
            return callback(err);
        }

        if (result.body.PagingInfo.HasMoreItems) {
            var bookmark = result.body.PagingInfo.Bookmark;
            var nextUrl = url + (url.includes('?') ? '&' : '?') + 'bookmark=' + encodeURIComponent(bookmark);
            console.log('GET ' + nextUrl);
            request
                .get(nextUrl)
                .set('Authorization', `Bearer ${access_token}`)
                .end(function(err, result) {
                    handlePage(err, result, items);
                });
        } else { // Last page.
            callback(null, items);
        }
    }
}

/**
 * Since codes are not unique and matches are substring-based, let's see if we can extract at max. one item.
 * @returns the one item that has an exact match or null if there is none.
 */
function getExactMatch(items, filter, callback) {
    items = _.filter(items, filter); // Dump the substring matches, we only want exact matches.
    if (items.length > 1) { // This should never happen, but can happen nonetheless.
        err = "Error: multiple items found";
        callback(err);
    } else if (items.length < 1) { // No item found.
        callback(null, null);
    } else { // One item found.
        callback(null, items[0]);
    }
}

/**
 * We don't want to bother knowing when to use which label for the identifier.
 * @returns the value of the identifier.
 */
function getId(item) {
    return item.Id ? item.Id : item.Identifier;
}

app.listen(port);
console.log(`HTTP started on port ${port}.`);

module.exports = app;
