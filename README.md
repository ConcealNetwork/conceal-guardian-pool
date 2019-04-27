# conceal-guardian-pool

Pool for monitoring Conceal node Guardian instances. Also provides random selection of a node.
The pool also has an "inactive cleanup feature". If a node does not send data for a specific ammount of time it is delisted from the pool until it sends the data again. Pool also has DDOS protection.

Currently there are 3 API endpoints described bellow

* /pool/update -> This is the endpoint to which each node guardian is sending the node data in intervals
* /pool/random -> Selects a random node from a list of all nodes. Additional parametes may narrow the list.
* /pool/list -> Lists all the nodes currently in the pool. Additional parametes may narrow the list.

# Supported Parameters (for random and list endpoints)

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
