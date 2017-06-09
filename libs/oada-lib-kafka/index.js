const debug = require('debug');
const trace = debug('oada-lib-kafka:trace');
const info = debug('oada-lib-kafka:info');
const error = debug('oada-lib-kafka:error');

const uuid = require('uuid');
const Promise = require('bluebird');
const kf = Promise.promisifyAll(require('kafka-node'));
const oadaLib = require('../../libs/oada-lib-arangodb');
const config = require('./config');

const healthtopic = 'oada-lib-kafka:health-checks';
const tryProduceConsume = client => {
  return new Promise((resolve,reject) => {
    // This whole process should finish in a bounded amout of time
    let waiting = setTimeout(() => {
        info('tryProduceConsume: timer expired, closing consumer, trying again.');
        client.closeAsync().finally(() => 
          reject(new Error('Timeout: failed to get message in less than 10 seconds'))
        );
      }, 10000 // 10 seconds ought to do it
    );

    // Create a producer for dummy topic, and a consumerGroupfor that topic
    trace('tryProduceConsume: Creating producer/consumer for dummy topic to ensure connection');
    const producer = Promise.promisifyAll(new kf.Producer(client, {partitionerType: 0}));
    const consumer = Promise.promisifyAll(new kf.ConsumerGroup({
      host: config.get('zookeeper:host'),
      groupId: 'oada-lib-kafka_ensureClient',
      fromOffset: 'latest',
    }, [ healthtopic ]));

    //--------------------------------------------
    // setup consumer
    trace('tryProduceConsume: setting message handler');
    consumer.onAsync('message').then(msg => {
      clearTimeout(waiting); waiting = null;
      // Success case:
      info('tryProduceConsume: successfully consumed message, closing consumer and returning client');
      return consumer.closeAsync().then(() => resolve(client));
    }).catch(err => {
      info('tryProduceConsume: failed on message consumption');
      clearTimeout(waiting); waiting = null;
      reject(new Error(err.toString()));
    });
    consumer.onAsync('error').then(err => {
      info('tryProduceConsume: exception thrown on consumer.  err = '+err.toString());
      clearTimeout(waiting); waiting = null;
      client.closeAsync().finally(() => reject(new Error(err.toString())));
    });

    //----------------------------------------------
    // setup producer and send message
    producer.onAsync('error').then(() => {
      info('tryProduceConsume: exception thrown on producer.  err = '+err.toString());
      clearTimeout(waiting); waiting = null;
      client.closeAsync().finally(() => reject(new Error(err.toString()));
    });
    trace('tryProduceConsume: producing message');
    producer.onAsync('ready').then(() => {
      trace('tryProduceConsume: producer ready, producing message');
      return producer.sendAsync( [ 
        { topic: healthtopic, partition: 0, messages: { hello: 'healthcheck' } },
      ]).then(() => trace('tryProduceConsume: send complete'));
    }).catch(err => {
      clearTimeout(waiting); waiting = null;
      info('tryProduceConsume: failed to produce.  err = ', err);
      client.closeAsync().finally(() => reject(new Error(err.toString())));
    });
  });
}

const ensureClient = (clientname, topicnames) => {
  trace('ensureClient: creating client');
  const client = Promise.promisifyAll(new kf.Client(config.get('zookeeper:host'), clientname));
  
  let refreshCount = 0;
  trace('ensureClient: calling tryProduceConsume for first attempt');
  return client.refreshMetadataAsync()
  .return(client)
  .then(tryProduceConsume)
  .catch(err => {
    if (refreshCount++ > 20) {
      info('Failed too many times to tryProduceConsume, throwing up.');
      throw err;
    }
    info('Failed to tryProduceConsume: trying again on attempt #'+refreshCount+', err = ', err);
    return tryProduceConsume(client);
  });
};

module.exports = {
  ensureClient,
};
