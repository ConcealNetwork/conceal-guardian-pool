# conceal-guardian-pool

Pool for monitoring Conceal node Guardian instances. Also provides random selection of a node.
The pool also has an "inactive cleanup feature". If a node does not send data for a specific ammount of time it is delisted from the pool until it sends the data again. Pool also has DDOS protection.

Currently there are 3 API endpoints described bellow

* /pool/update -> This is the endpoint to which each node guardian is sending the node data in intervals
* /pool/random -> Selects a random node from a list of all nodes. Additional parametes may narrow the list.
* /pool/list -> Lists all the nodes currently in the pool. Additional parametes may narrow the list.
* /pool/count -> Counts all the nodes currently in the pool. Additional parametes may narrow the list.
* /pool/uptime -> Get a list uf node uptimes for the given input parameters

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

**isSynced**:  Only looks at those nodes that are fully synced. If not specified every nodes passes the test.

```
/pool/random?isSynced=true
/pool/list?isSynced=true
```

# Supported Parameters for uptime endpoint

To call **/pool/uptime** endpoint you can do either an get or post request. If you want to specify the input parameters you need to do the post request where the payload is JSON. Example of input payload:

```
{
	"id": ["19f0b65e-ea13-4f1c-be15-035568051103", "235cbefa-91b3-453e-8eda-e907be6624aa"],
  	"month": [5,6],
  	"year": [2019]
}
```

* **id**: an array of ids you want to query. If not specified all ids are taken
* **month**: an array of months you want to query for. If not specified all months are taken
* **year**: an array of years you want to querty for. If not specified all years are taken

The API sums the ticks for each client over the given period selected by parameters. The same is done for the pool ticks. The uptime is client ticks divided by pool ticks.

An example of the result:

```
{
    "uptimes": [
        {
            "id": "19f0b65e-ea13-4f1c-be15-035568051103",
            "clientTicks": 320,
            "serverTicks": 327
        },
        {
            "id": "235cbefa-91b3-453e-8eda-e907be6624aa",
            "clientTicks": 327,
            "serverTicks": 327
        }
    ]
}
```


