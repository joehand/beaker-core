const assert = require('assert')
const _difference = require('lodash.difference')
const Events = require('events')
const {Url} = require('url')
const lock = require('../lib/lock')
const db = require('../dbs/profile-data-db')
const crawler = require('./index')
const siteDescriptions = require('./site-descriptions')
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

exports.crawlSite = async function (archive, crawlSource) {
  return doCrawl(archive, crawlSource, 'crawl_followgraph', TABLE_VERSION, async ({changes, resetRequired}) => {
    const supressEvents = resetRequired === true // dont emit when replaying old info
    console.log('Crawling follows for', archive.url, {changes, resetRequired})
    if (resetRequired) {
      // reset all data
      await db.run(`
        DELETE FROM crawl_followgraph WHERE crawlSourceId = ?
      `, [crawlSource.id])
      await doCheckpoint('crawl_followgraph', TABLE_VERSION, crawlSource, 0)
    }

    // did follows.json change?
    var change = changes.find(c => c.name === JSON_PATH)
    if (!change) {
      return
    }

    // read and validate
    try {
      var followsJson = await readFollowsFile(archive)
    } catch (err) {
      console.error('Failed to read follows file', {url: archive.url, err})
      debug('Failed to read follows file', {url: archive.url, err})
      return
    }

    // diff against the current follows
    var currentFollows = await listFollows(archive.url)
    var newFollows = followsJson.urls
    var adds = _difference(newFollows, currentFollows)
    var removes = _difference(currentFollows, newFollows)

    // write updates
    for (let add of adds) {
      try {
        await db.run(`
          INSERT INTO crawl_followgraph (crawlSourceId, destUrl, crawledAt) VALUES (?, ?, ?)
        `, [crawlSource.id, add, Date.now()])
      } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT') {
          // uniqueness constraint probably failed, which means we got a duplicate somehow
          // dont worry about it
          debug('Attempted to insert duplicate followgraph record', {crawlSource, url: add})
        } else {
          throw e
        }
      }
      if (!supressEvents) {
        events.emit('follow-added', archive.url, add)
      }
    }
    for (let remove of removes) {
      await db.run(`
        DELETE FROM crawl_followgraph WHERE crawlSourceId = ? AND destUrl = ?
      `, [crawlSource.id, remove])
      if (supressEvents) {
        events.emit('follow-removed', archive.url, remove)
      }
    }

    // write checkpoint as success
    await doCheckpoint('crawl_followgraph', TABLE_VERSION, crawlSource, changes[changes.length - 1].version)
  })
}

// List sites that follow subject
// - subject. String (URL).
// - opts.followedBy. String (URL).
// - opts.includeDesc. Boolean.
// - returns Array<String | Object>
const listFollowers = exports.listFollowers = async function (subject, {followedBy, includeDesc} = {}) {
  var rows
  if (followedBy) {
    rows = await db.all(`
      SELECT cs.url FROM crawl_followgraph fg
        INNER JOIN crawl_sources cs ON cs.id = fg.crawlSourceId
        WHERE fg.destUrl = ?
          AND (cs.url = ? OR cs.url IN (
            SELECT destUrl as url FROM crawl_followgraph
              INNER JOIN crawl_sources ON crawl_sources.id = crawl_followgraph.crawlSourceId
              WHERE crawl_sources.url = ?
          ))
    `, [subject, followedBy, followedBy])
  } else {
    rows = await db.all(`
      SELECT f.url
        FROM crawl_sources f
        INNER JOIN crawl_followgraph
          ON crawl_followgraph.crawlSourceId = f.id
          AND crawl_followgraph.destUrl = ?
    `, [subject])
  }
  if (!includeDesc) {
    return rows.map(row => toOrigin(row.url))
  }
  return Promise.all(rows.map(async (row) => {
    var url = toOrigin(row.url)
    var desc = await siteDescriptions.getBest({subject: url})
    desc.url = url
    if (followedBy) {
      desc.followsUser = await isAFollowingB(url, followedBy)
    }
    return desc
  }))
}

// List sites that subject follows
// - subject. String (URL).
// - opts.followedBy. String (URL). Filters to users who are followed by the URL specified. Causes .followsUser boolean to be set.
// - opts.includeDesc. Boolean.
// - opts.includeFollowers. Boolean. Requires includeDesc to be true.
// - returns Array<String | Object>
const listFollows = exports.listFollows = async function (subject, {followedBy, includeDesc, includeFollowers} = {}) {
  var rows = await db.all(`
    SELECT crawl_followgraph.destUrl
      FROM crawl_followgraph
      INNER JOIN crawl_sources
        ON crawl_followgraph.crawlSourceId = crawl_sources.id
        AND crawl_sources.url = ?
  `, [subject])
  if (!includeDesc) {
    return rows.map(row => toOrigin(row.destUrl))
  }
  return Promise.all(rows.map(async (row) => {
    var url = toOrigin(row.destUrl)
    var desc = await siteDescriptions.getBest({subject: url, author: subject})
    desc.url = url
    if (followedBy) {
      desc.followsUser = await isAFollowingB(url, followedBy)
    }
    if (includeFollowers) {
      desc.followedBy = await listFollowers(url, {followedBy, includeDesc: true})
    }
    return desc
  }))
}

// List sites that are followed by sites that the subject follows
// - subject. String (URL).
// - opts.followedBy. String (URL).
// - returns Array<Object>
const listFoaFs = exports.listFoaFs = async function (subject, {followedBy} = {}) {
  var foafs = []
  // list URLs followed by subject
  var follows = await listFollows(subject, {followedBy, includeDesc: true})
  for (let follow of follows) {
    // list follows of this follow
    for (let foaf of await listFollows(follow.url, {followedBy, includeDesc: true})) {
      // ignore if followed by subject
      if (follows.find(v => v.url === foaf.url)) continue
      // merge into list
      let existingFoaF = foafs.find(v => v.url === foaf.url)
      if (existingFoaF) {
        existingFoaF.followedBy.push(follow)
      } else {
        foaf.followedBy = [follow]
        foafs.push(foaf)
      }
    }
  }
  return foafs
}

// Check for the existence of an individual follow
// - a. String (URL), the site being queried.
// - b. String (URL), does a follow this site?
// - returns bool
const isAFollowingB = exports.isAFollowingB = async function (a, b) {
  a = toOrigin(a)
  b = toOrigin(b)
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

exports.follow = async function (archive, followUrl) {
  // normalize followUrl
  followUrl = toOrigin(followUrl)
  assert(typeof followUrl === 'string', 'Follow() must be given a valid URL')

  // write new follows.json
  await updateFollowsFile(archive, followsJson => {
    if (!followsJson.urls.find(v => v === followUrl)) {
      followsJson.urls.push(followUrl)
    }
  })

  // capture site description
  /* dont await */siteDescriptions.capture(archive, followUrl)
}

exports.unfollow = async function (archive, followUrl) {
  // normalize followUrl
  followUrl = toOrigin(followUrl)
  assert(typeof followUrl === 'string', 'Unfollow() must be given a valid URL')

  // write new follows.json
  await updateFollowsFile(archive, followsJson => {
    var i = followsJson.urls.findIndex(v => v === followUrl)
    if (i !== -1) {
      followsJson.urls.splice(i, 1)
    }
  })
}

// internal methods
// =

function toOrigin (url) {
  try {
    url = new URL(url)
    return url.protocol + '//' + url.hostname
  } catch (e) {
    return null
  }
}

async function readFollowsFile (archive) {
  try {
    var followsJson = await archive.pda.readFile(JSON_PATH, 'utf8')
  } catch (e) {
    if (e.notFound) return {type: JSON_TYPE, urls: []} // empty default when not found
    throw e
  }
  followsJson = JSON.parse(followsJson)
  assert(typeof followsJson === 'object', 'File be an object')
  assert(followsJson.type === JSON_TYPE, 'JSON type must be unwalled.garden/follows')
  assert(Array.isArray(followsJson.urls), 'JSON .urls must be an array of strings')
  followsJson.urls = followsJson.urls.filter(v => typeof v === 'string').map(toOrigin)
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
    await archive.pda.writeFile(JSON_PATH, JSON.stringify(followsJson), 'utf8')

    // trigger crawl now
    await crawler.crawlSite(archive)
  } finally {
    release()
  }
}
