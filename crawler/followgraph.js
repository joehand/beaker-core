const assert = require('assert')
const _difference = require('lodash.difference')
const Events = require('events')
const lock = require('../lib/lock')
const db = require('../dbs/profile-data-db')
const {doCrawl, doCheckpoint} = require('./util')
const debug = require('../lib/debug-logger').debugLogger('crawler')

// constants
// =

const TABLE_VERSION = 1
const JSON_TYPE = 'unwalled.garden/follows'
const JSON_PATH = '/data/follows.json'

// globals
// =

var events = new Events()

// exported api
// =

exports.on = events.on.bind(events)
exports.addListener = events.addListener.bind(events)
exports.removeListener = events.removeListener.bind(events)

exports.crawlSite = async function (archive, crawlSourceId) {
  return doCrawl(archive, 'crawl_followgraph', TABLE_VERSION, async ({changes, resetRequired}) => {
    const supressEvents = resetRequired === true // dont emit when replaying old info
    if (resetRequired) {
      // reset all data
      await db.run(`
        DELETE FROM crawl_followgraph WHERE crawlSourceId = ?
      `, [crawlSourceId])
      await doCheckpoint('crawl_followgraph', TABLE_VERSION, crawlSourceId, 0)
    }

    // did follows.json change?
    var change = changes.find(c => c.path === JSON_PATH)
    if (!change) {
      return
    }

    // read and validate
    try {
      var followsJson = await readFollowsFile(archive)
    } catch (err) {
      debug('Failed to read follows file', {url: archive.url, err})
      return
    }

    // diff against the current follows
    var currentFollows = await listFollows(archive)
    var newFollows = followsJson.urls
    var adds = _difference(newFollows, currentFollows)
    var removes = _difference(currentFollows, newFollows)

    // write updates
    for (let add of adds) {
      await db.run(`
        INSERT INTO crawl_followgraph (crawlSourceId, destUrl, crawledAt) VALUES (?, ?, ?)
      `, [crawlSourceId, add, Date.now()])
      if (!supressEvents) {
        events.emit('follow-added', archive.url, add)
      }
    }
    for (let remove of removes) {
      await db.run(`
        DELETE FROM crawl_followgraph WHERE crawlSourceId = ? AND destUrl = ?
      `, [crawlSourceId, remove])
      if (supressEvents) {
        events.emit('follow-removed', archive.url, remove)
      }
    }

    // write checkpoint as success
    await doCheckpoint('crawl_followgraph', TABLE_VERSION, crawlSourceId, changes[changes.length - 1].version)
  })
}

// List urls of sites that follow subject
// - subject. String (URL).
// - returns Array<String>
exports.listFollowers = async function (subject) {
  var rows = await db.all(`
    SELECT crawl_sources.url
      FROM crawl_sources
      INNER JOIN crawl_followgraph
        ON crawl_followgraph.crawlSourceId = crawl_sources.id
        AND crawl_followgraph.destUrl = ?
  `, [subject])
  return rows.map(row => row.url)
}

// List urls of sites that subject follows
// - subject. String (URL).
// - returns Array<String>
const listFollows = exports.listFollows = async function (subject) {
  var rows = await db.all(`
    SELECT crawl_followgraph.destUrl
      FROM crawl_followgraph
      INNER JOIN crawl_sources
        ON crawl_followgraph.crawlSourceId = crawl_sources.id
        AND crawl_sources.url = ?
  `, [subject])
  return rows.map(row => row.destUrl)
}

// Check for the existence of an individual follow
// - a. String (URL), the site being queried.
// - b. String (URL), does a follow this site?
// - returns bool
exports.isAFollowingB = async function (a, b) {
  var res = await db.get(`
    SELECT crawl_sources.id
      FROM crawl_sources
      INNER JOIN crawl_followgraph
        ON crawl_followgraph.crawlSourceId = crawl_sources.id
        AND crawl_followgraph.destUrl = ?
      WHERE crawl_sources.url = ?
  `, [b, a])
  return !!res
}

exports.follow = function (archive, followUrl) {
  // normalize followUrl
  // TODO
  assert(typeof followUrl === 'string', 'Follow() must be given a valid URL')

  return updateFollowsFile(archive, followsJson => {
    if (!followsJson.urls.find(v => v === followUrl)) {
      followsJson.urls.push(followUrl)
    }
  })
}

exports.unfollow = function (archive, followUrl) {
  // normalize followUrl
  // TODO
  assert(typeof followUrl === 'string', 'Unollow() must be given a valid URL')

  return updateFollowsFile(archive, followsJson => {
    var i = followsJson.urls.findIndex(v => v === followUrl)
    if (i !== -1) {
      followsJson.urls.splice(i, 1)
    }
  })
}

// internal methods
// =

async function readFollowsFile (archive) {
  var followsJson = JSON.parse(await archive.pda.readFile(JSON_PATH, 'utf8'))
  assert(typeof followsJson === 'object', 'File be an object')
  assert(followsJson.type === JSON_TYPE, 'JSON type must be unwalled.garden/follows')
  assert(Array.isArray(followsJson.follows), 'JSON follows must be an array of strings')
  followsJson.follows = followsJson.follows.filter(v => typeof v === 'string')
  return followsJson
}

async function updateFollowsFile (archive, updateFn) {
  var release = await lock('crawler:followgraph:' + archive.url)
  try {
    // read the follows file
    try {
      var followsJson = await readFollowsFile(archive)
    } catch (err) {
      if (err.notFound) {
        // create new
        followsJson = {
          type: JSON_TYPE,
          urls: []
        }
      } else {
        debug('Failed to read follows file', {url: archive.url, err})
        throw err
      }
    }

    // apply update
    updateFn(followsJson)

    // write the follows file
    await archive.pda.readFile(JSON_PATH, JSON.stringify(followsJson), 'utf8')
  } finally {
    release()
  }
}
