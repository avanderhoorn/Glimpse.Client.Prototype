'use strict';

var _ = require('lodash');
var chance = require('./fake-extension'); // TODO: Can I just import chance and have this wired up differently
var moment = require('moment'); 
var request = require('superagent');
var requestMock = require('superagent-mocker')(request);
var $ = require('lib/modules/jquery-signalr.js');
var $hubConnectionMock;
var glimpse = require('glimpse');

// TODO: remove into its own module
$hubConnectionMock = (function() {
    var mocks = {};
    
    return {
        on: function(topic, mockCallback) {
            mocks[topic] = mockCallback;
        },
        trigger: function(topic, userCallback) {
            if (mocks[topic]) {
                var result = mocks[topic](); 
                userCallback(result);
            }
        }
    }
})();
$.hubConnection = function() {
    var connection = {
            createHubProxy: function() {
                return {
                    on: function(topic, callback) {
                        $hubConnectionMock.trigger(topic, callback);
                    }
                };
            },
            start: function() {
                // open up fake socket
                return connection;
            },
            done: function(doneCallback) {
                return connection;
            },
            fail: function(failCallback) {
                return connection;
            }
        };
    return connection;
};
    
    
var _rawRequestCache = {};
 
var requestProcessor = {
    requests: {  
        summary: function(rawRequests) {
            var requests = _.map(rawRequests, 'request');
            
            // since the message is on the client it is assumed the payload is hydrated
            _.each(requests, function(request) {
                _.each(request.messages, function(message) {
                    if (message.payload && message.payload != '') {
                        message.payload = JSON.parse(message.payload);
                    }
                });
            });
            
            return {
                newRequests: requests,
                updatedRequests: [],
                affectedRequests: requests
            };
        },
        detail: function(rawRequest) {
            var requests = [ rawRequest.request ];
            
            return {
                newRequests: requests,
                updatedRequests: [],
                affectedRequests: requests
            };
        }  
    },
    messages: { 
        summary: function(rawRequests) {
            var messages = [];
            _.forEach(rawRequests, function(request) { 
                _.forEach(request.messages, function(message) {  
                    if (!_.isEmpty(message.indices) || !_.isEmpty(message.abstract)) { 
                        messages.push(message);
                    }
                });
            });
            
            return messages;
        },
        detail: function(rawRequest) {
            return rawRequest.messages; 
        } 
    }
};


// simulate summaries
var summaries = (function () {
    var maxEvents = chance.integerRange(25, 35);
    var leftEvents = maxEvents;
    
    var batch = (function() {
        var calculateOffset = function(seconds) {
            var date = new Date();
            var value = seconds * 1000;

            return moment(date.setTime(date.getTime() + value)).toISOString();
        };
        
        var generateResults = function(count, offset) {
            var results = [];
            for (var i = 0; i < count; i++) {
                offset -= chance.integerRange(30, 300);

                var dateTime = calculateOffset(offset); 
                var result = chance.mvcRequest(dateTime);

                results.push(result);
            }

            return results;
        };
        var cacheResults = function(rawResults) {
            _.forEach(rawResults, function(rawResult) {
                _rawRequestCache[rawResult.id] = rawResult;
            });
        };
        var publishResults = function(rawResults, publishAction, messageType, messageSource) {
            var results = publishAction(rawResults);
            
            glimpse.emit('data.' + messageType + '.summary.found.' + messageSource, results);
        };
        
        return function(count, messageType, messageSource, offset, publishAction) {
            leftEvents -= parseInt(count);
            
            console.log('[fake] ' + messageType + ':' + messageSource + ' - ' + (maxEvents - leftEvents) + ' of ' + maxEvents + ' (' + leftEvents + ' left, ' + parseInt(count) + ' just rendered)');
            
            var rawResults = generateResults(count, offset);
            cacheResults(rawResults);
            publishResults(rawResults, publishAction, messageType, messageSource);
        };
    })();

    var generate = { 
        local: function () { 
            // simulate requests happening more than a day ago
            batch(maxEvents * 0.25, 'request', 'local', 25 * 60 * 60 * -1, requestProcessor.requests.summary);
            
            // TODO: detail summary request objects just for these, and create full details just for some
        },
        remote: function () { 
            // simulate messages happening more than 10 seconds ago
            batch(maxEvents * 0.3, 'message', 'remote', 10 * -1, requestProcessor.messages.summary);
        }, 
        stream: function (position) {
            // simulate message happening now and possibly coming in at the same time
            
            // TODO: stream should not be subject to random time generation, currently is
            
            var count = chance.integerRange(0, 100) > 75 ? 2 : 1;  
            batch(count, 'message', 'stream', 0, requestProcessor.messages.summary);
            
            // lets make more happen
            setTimeout(function () {
                if (leftEvents > 0) {
                    generate.stream(position + count);
                }
            }, chance.integerRange(500, 15000));
        }
    };

    return {
        local: function() {
            // simulate requests from local store
            setTimeout(function () {
                generate.local();
            }, chance.integerRange(50, 100));
        },
        remote: function() {
            // simulate messages from remote
            setTimeout(function () {
                generate.remote();
            }, chance.integerRange(2000, 2500));
        },
        stream: function() {
            // simulate messages from stream
            setTimeout(function () {
                generate.stream(0);
            }, chance.integerRange(4000, 6000));
        }
    };
})();

// simulate details 
var details = (function () { 
    var requestsFound = function(messageType, messageSource, results) {
        glimpse.emit('data.' + messageType + '.detail.found.' + messageSource, results);
    };
    
    var generate = {  
        remote: function (id) { 
            // TODO: Should probably throw an exeption if record not found
            var rawRequest = _rawRequestCache[id];
            if (rawRequest) {  
                requestsFound('message', 'remote', requestProcessor.messages.detail(rawRequest));
            }
            else { 
                throw new TypeError('Shouldnt be trying to find a detail that we dont have a summary for');
            }
        }
    };

    return {
        remote: function (id) { 
            // simulate messages from remote
            setTimeout(function () {
                generate.remote(id);
            }, chance.integerRange(2000, 3000));
        }
    };
})();

// hook up listeners
(function () {
    glimpse.on('shell.request.ready', function() { 
        summaries.local();
    });
    
    // remote triggers
    requestMock.get('/glimpse/data/history', function(req) { 
        summaries.remote();
        
        // TODO: need to return data
        //return data;
    }); 
    requestMock.get('/glimpse/data/messages/:id', function(req) {
        details.remote(req.params.id); 
    });
    
    // stream subscribers
    $hubConnectionMock.on('summaryMessage', function() {
        summaries.stream();
    });
})();
