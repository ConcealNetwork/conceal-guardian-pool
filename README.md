# conceal-guardian-pool

Pool for monitoring Conceal node Guardian instances. Also provides random selection of a node.
The pool also has an "inactive cleanup feature". If a node does not send data for a specific ammount of time it is delisted from the pool until it sends the data again. Pool also has DDOS protection.

## API endpoints:

* /pool/update -> Guardian notify. Send the raw UUID from `nodedata.json` as `id`. A **new** id or a **changed** host:port is stored only if the pool can `getinfo` that target. Same host, same id may skip the probe for 4 minutes (configurable via `probe.skipSeconds`); last probed height and fee stay (the client cannot overwrite them). Height more than one week ahead of the expected tip is rejected. A syncing (low) height is accepted if the daemon answers. One listing per probe host:port: a new id replaces the old one only after a successful `getinfo`. Submissions may carry an ed25519 proof-of-ownership envelope (see **Signed submissions** below): signed updates are preferred and keep their listing slot reserved, unsigned updates remain accepted during the transition and share a bounded budget of the node directory.
* /pool/random -> Selects a random node from a list of all nodes. Additional parametes may narrow the list.
* /pool/list -> Lists nodes in the pool. The `id` field is `sha256(guardian uuid)` hex, not the write secret. Default list is the synced set (see **isSynced**).
* /pool/count -> Counts nodes after the same filters as list.
* /pool/uptime -> Get a list uf node uptimes for the given input parameters. Query `id` with the public hash from `/pool/list` (raw UUID still works). Responses use the public hash.

# Supported Parameters for random, count and list endpoints

**hasFeeAddr**: Only looks at those nodes that have a fee address specified. If not specified every nodes passes the test.

```
/pool/random?hasFeeAddr=true
/pool/list?hasFeeAddr=true

```

**isReachable**:  Only looks at those nodes that are reachable (have open RFC port). If not specified every nodes passes the test.

```
/pool/random?isReachable=true
/pool/list?isReachable=true
```

**hasSSL**:  Only looks at those nodes that are reachable over the SSL protocol. If not specified every nodes passes the test.

```
/pool/random?hasSSL=true
/pool/list?hasSSL=true
```

**isSynced**: Only nodes the pool reached (`getinfo` ok) whose height is at least the seed anchor minus 2. The anchor is the median `getinfo` height of the official seeds when at least three of those replies sit on that height and share one `top_block_hash`. Each seed is reached by resolving its name. The last resolved address is kept in memory and used only when that name fails to resolve. Default is **on** (omit the query or `isSynced=true`). With no anchor, the synced set is empty. Use `isSynced=false` to include syncing or unreachable rows that are still in cache.

```
/pool/random?isSynced=true
/pool/list?isSynced=true
/pool/list?isSynced=false
```

# Supported Parameters for uptime endpoint

To call **/pool/uptime** endpoint you can do either an get or post request. If you want to specify the input parameters you need to do the post request where the payload is JSON. Example of input payload:

```
{
	"id": ["<guardian uuid or sha256 hex of that uuid>"],
	"month": [5,6],
	"year": [2019]
}
```

* **id**: either the raw Guardian UUID from `nodedata.json` or the `sha256` hex from `/pool/list` (mix them in the same array if you want). The response always uses the public hash. If not specified all ids are taken
* **month**: an array of months you want to query for. If not specified all months are taken
* **year**: an array of years you want to querty for. If not specified all years are taken

The API sums the ticks for each client over the given period selected by parameters. The same is done for the pool ticks. The uptime is client ticks divided by pool ticks.

To find your node on `/pool/list`, hash the UUID in Guardian `nodedata.json` (no newline):

```
echo -n '<uuid>' | sha256sum
```

An example of the result:

```
{
    "uptimes": [
        {
            "id": "<sha256 hex of guardian uuid>",
            "clientTicks": 320,
            "serverTicks": 327
        },
        {
            "id": "<sha256 hex of another guardian uuid>",
            "clientTicks": 327,
            "serverTicks": 327
        }
    ]
}
```

# Signed submissions (proof of ownership)

`/pool/update` accepts an optional ed25519 proof-of-ownership envelope. The Guardian client keeps an identity keypair and signs every submission, proving it still holds the key that created the listing. The signature binds the envelope timestamp and the exact submitted `id`, `nodeHost` and `nodePort`, so a captured payload cannot be re-pointed at another listing and a replay only re-asserts an identical binding within the clock-skew window.

Add an `auth` object to the update payload:

```
{
    "id": "<guardian uuid>",
    "nodeHost": "node.example.com",
    "nodePort": 16000,
    ...
    "auth": {
        "publicKey": "<64 hex chars, raw ed25519 public key>",
        "signature": "<128 hex chars, ed25519 signature>",
        "timestamp": 1762200000000
    }
}
```

The signed message is the envelope fields joined with `\n` (no trailing newline):

```
ccx-pool-update-v1
<timestamp>
<id>
<nodeHost>
<nodePort>
```

What signing buys, per stage:

* Now (`updateAuth.requireSigned: false`, the default): signed submissions are verified and get an id-to-key claim. A claimed id can only be updated or evicted from its host:port slot by its own key, each identity may hold at most `updateAuth.maxListingsPerKey` concurrent listings, and verified identities are exempt from the anonymous listing budget (`updateAuth.anonymousListingCap` of the 500-slot directory), so a flood of unsigned submissions cannot starve them. Unsigned submissions keep working for existing clients, but once the anonymous budget is full, new unsigned ids are refused until slots free up. An envelope that is present but invalid (bad signature, stale timestamp, malformed key) is always rejected — it never falls back to unsigned.
* Cutover (`updateAuth.requireSigned: true`): unsigned submissions are refused outright and every update requires proof of key ownership.
* `updateAuth.maxSkewSeconds` (default 300) bounds how far the envelope timestamp may drift from pool time.

Ownership claims live in memory only — nothing about them is written to the database. A pool restart forgets claims until each owner re-submits a signed update. To generate the identity keypair and sign a message with Node:

```
node -e "console.log(require('node:crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))"
crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex')
```



