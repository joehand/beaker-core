const globals = require('../../globals')
const assert = require('assert')
const {Url} = require('url')
const {PermissionsError} = require('beaker-error-constants')
const dat = require('../../dat')
const followgraphCrawler = require('../../crawler/followgraph')

// exported api
// =

module.exports = {

  async listFollowers (url, opts) {
    opts = opts || {}
    url = normalizeFollowUrl(url)
    assertString(url, 'Parameter one must be a URL')
    var userSession = globals.userSessionAPI.getFor(this.sender)
    if (!userSession) throw new Error('No active user session')
    opts.followedBy = userSession.url
    return followgraphCrawler.listFollowers(url, opts)
  },

  async listFollows (url, opts) {
    opts = opts || {}
    url = normalizeFollowUrl(url)
    assertString(url, 'Parameter one must be a URL')
    var userSession = globals.userSessionAPI.getFor(this.sender)
    if (!userSession) throw new Error('No active user session')
    opts.followedBy = userSession.url
    return followgraphCrawler.listFollows(url, opts)
  },

  async listFoaFs (url, opts) {
    opts = opts || {}
    url = normalizeFollowUrl(url)
    assertString(url, 'Parameter one must be a URL')
    var userSession = globals.userSessionAPI.getFor(this.sender)
    if (!userSession) throw new Error('No active user session')
    opts.followedBy = userSession.url
    return followgraphCrawler.listFoaFs(url, opts)
  },

  async isAFollowingB (a, b) {
    a = normalizeFollowUrl(a)
    b = normalizeFollowUrl(b)
    assertString(a, 'Parameter one must be a URL')
    assertString(b, 'Parameter two must be a URL')
    return followgraphCrawler.isAFollowingB(a, b)
  },

  async follow (url) {
    url = normalizeFollowUrl(url)
    assertString(url, 'Parameter one must be a URL')
    var userSession = globals.userSessionAPI.getFor(this.sender)
    if (!userSession) throw new Error('No active user session')
    var userArchive = dat.library.getArchive(userSession.url)
    return followgraphCrawler.follow(userArchive, url)
  },

  async unfollow (url) {
    url = normalizeFollowUrl(url)
    assertString(url, 'Parameter one must be a URL')
    var userSession = globals.userSessionAPI.getFor(this.sender)
    if (!userSession) throw new Error('No active user session')
    var userArchive = dat.library.getArchive(userSession.url)
    return followgraphCrawler.unfollow(userArchive, url)
  }
}

// internal methods
// =

function normalizeFollowUrl (url) {
  try {
    url = new URL(url)
    return url.protocol + '//' + url.hostname
  } catch (e) {}
  return null
}

function assertString (v, msg) {
  assert(!!v && typeof v === 'string', msg)
}
