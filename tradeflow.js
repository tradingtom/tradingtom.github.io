
class WSTracker {
  static _instance = null;

  _socket = null;
  _subscriptions = new Map();
  _clockDrift = 0;
  tradeTTL = '10m';

  on(event, handler) {
    this._socket.addEventListener(event, handler);
  }

  _formatData(data) { return undefined; }

  _setReady() {
    this.ready = new Promise((resolve, reject) => {
      this.on('open', resolve);
      this.on('error', reject);
      this.on('close', () => this.close());
    }).then(() => {
      this.on('message', message => {
        let data;

        try {
          data = JSON.parse(message.data);
        } catch(e) { return; }

        data = this._formatData(data);

        if (!data) return;

        this._clockDrift = ((this._clockDrift + (new Date()).getTime() - data.time) / 2) | 0;

        const subscription = this._subscriptions.get(data.symbol);

        if (!subscription) return;

        const trades = subscription.trades;
        let insertID = 0;

        trades.every((trade, key) => {
          if (trade.time === data.time) {
            trade.size += data.size;
            insertID = -1;

            if (trade.price !== data.price) {
              trade.slippage.push(data.price);
            }

            return false;
          }

          if (trade.time < data.time) {
            insertID = key;

            return false;
          }

          return true;
        });

        if (insertID !== -1) {
          trades.splice(insertID, 0, data);
        }

        subscription.used.forEach(handler => handler(this._pruneTrades(subscription.trades.slice())));
      });
    });
  }

  _pruneTrades(trades) {
    let tradeTTL = this.tradeTTL;
    const duration = momentDuration(tradeTTL);

    if (duration) {
      if (trades.length === 0) return trades;

      const until = moment(trades[0].time).subtract(...duration);
      const firstOlder = trades.findIndex(({ time }) => until > moment(time));

      if (firstOlder !== -1) {
        trades.length = firstOlder;
      }

      return trades;
    } else if ((tradeTTL = parseInt(tradeTTL, 10)) > 0) {
      if (trades.length > tradeTTL) {
        trades.length = tradeTTL;
      }

      return trades;
    }
  }

  get isOpen() {
    return this._socket && this._socket.readyState === WebSocket.OPEN;
  }

  get subscriptions() {
    return this._subscriptions;
  }

  subscribe(symbol, handler) {
    symbol = String(symbol).toUpperCase();

    let subscription = this._subscriptions.get(symbol);

    if (subscription) {
      subscription.used.add(handler);
      subscription.used.forEach(handler => handler(subscription.trades.slice()));
    } else {
      subscription = {
        used: new Set([handler]),
        trades: [],
      };
      this._subscriptions.set(symbol, subscription);
    }

    return subscription.used.size;
  }

  unsubscribe(symbol, handler) {
    symbol = String(symbol).toUpperCase();

    let subscription = this._subscriptions.get(symbol);

    if (subscription) {
      subscription.used.delete(handler);

      if (subscription.used.size < 1) {
        this._subscriptions.delete(symbol);
      }
    } else {
      return false;
    }

    if (this._subscriptions.size === 0) {
      this.close();

      return null;
    }

    return subscription.used.size;
  }

  close() {
    if (this._socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(this._socket.readyState)) {
      this._socket.close();
    }

    this._socket = null;
    this.constructor._instance = null;
  }
}

class BitFinexWS extends WSTracker {
  constructor() {
    super();

    if (BitFinexWS._instance) {
      return BitFinexWS._instance;
    }

    BitFinexWS._instance = this;
    this._socket = new WebSocket('wss://api.bitfinex.com/ws/2');
    this.on('message', message => {
      let data;

      try {
        data = JSON.parse(message.data);
      } catch(e) { return; }

      if (data.event === 'subscribed') {
        const subscription = this._subscriptions.get(data.pair);

        if (subscription) {
          subscription.channel = data.chanId;
        }
      }
    });
    this._setReady();
  }

  _formatData(data) {
    if (data[1] !== 'te') return;

    const [
      channel,
      , 
      [
        ,
        time,
        size,
        price
      ]
    ] = data;

    let found;

    this._subscriptions.forEach(({ channel }, symbol) => {
      if (data[0] === channel) {
        found = {
          symbol,
          time,
          side: size < 0 ? 's' : 'b',
          size: Math.abs(size),
          price,
          slippage: []
        };
      }
    });

    return found;
  }

  subscribe(symbol, handler) {
    symbol = String(symbol).toUpperCase();

    if (super.subscribe(symbol, handler) === 1) {
      this._socket.send(JSON.stringify({ 
        event: 'subscribe', 
        channel: 'trades', 
        symbol
      }));
    }
  }

  unsubscribe(symbol, handler) {
    symbol = String(symbol).toUpperCase();

    if (super.unsubscribe(symbol, handler) === 0) {
      this._socket.send(JSON.stringify({ 
        event: 'subscribe', 
        channel: 'trades', 
        symbol 
      }));
    }
  }
}
class BitFlyerWS extends WSTracker {
  constructor() {
    super();

    if (BitFlyerWS._instance) {
      return BitFlyerWS._instance;
    }

    BitFlyerWS._instance = this;
    this._socket = new PubNub({subscribeKey: 'sub-c-52a9ab50-291b-11e5-baaa-0619f8945a4f'});
     this._setReady();
  }

  on(event, handler) {
    this._socket.addListener({
      [event]: handler
    });
  }

  processMsg(data) {
    
    if (data.channel) {
      const subscription = this._subscriptions.get(data.channel);

      if (subscription) {
        subscription.channel = data.channel;
      }
    }

    data = this._formatData(data);

    if (!data) return;

    this._clockDrift = ((this._clockDrift + (new Date()).getTime() - data.time) / 2) | 0;

    const subscription = this._subscriptions.get(data.symbol);

    if (!subscription) return;

    const trades = subscription.trades;
    let insertID = 0;

    trades.every((trade, key) => {
      if (trade.time === data.time) {
        trade.size += data.size;
        insertID = -1;

        if (trade.price !== data.price) {
          trade.slippage.push(data.price);
        }

        return false;
      }

      if (trade.time < data.time) {
        insertID = key;

        return false;
      }

      return true;
    });

    if (insertID !== -1) {
      trades.splice(insertID, 0, data);
    }

    subscription.used.forEach(handler => handler(subscription.trades.slice()));
  }

  _setReady() {
    this.ready = new Promise((resolve, reject) => {
      resolve();
    }).then(() => {
      this.on('message', message => {
        let data;
        message.message.forEach(msg => {
          msg.channel = message.channel; 
          this.processMsg(msg);
        });
        
      });
    });
  }
  _formatData(data) {
    let time = new Date(data.exec_date).getTime();
    let side = data.side.charAt(0).toLowerCase();
    let { channel, size, price } = data;

    let found;

    this._subscriptions.forEach(({ channel }, symbol) => {
      if (data[0] === channel) {
        found = {
          symbol,
          time,
          side,
          size: Math.abs(size),
          price,
          slippage: []
        };
      }
    });

    return found;
  }

  subscribe(symbol, handler) {

    if (super.subscribe(symbol, handler) === 1) {
      symbol = String(symbol).toUpperCase();
      this._socket.subscribe({
        channels: ['lightning_executions_' + symbol]
      });
    }

  }

  unsubscribe(symbol, handler) {
    this._socket.unsubscribe({
      channels: ['lightning_executions_BTC_JPY']
    });
  }
}
class BitMexWS extends WSTracker {
  constructor() {
    super();

    if (BitMexWS._instance) {
      return BitMexWS._instance;
    }

    BitMexWS._instance = this;
    this._socket = new WebSocket('wss://www.bitmex.com/realtime');
    this._setReady();
  }

  _formatData({ action, table, data }) {
    if (!((table === 'trade') && (action === 'insert'))) return;

    const {
      symbol,
      timestamp,
      side,
      size,
      price
    } = data[0];

    const result = {
      symbol,
      time: (new Date(timestamp)).getTime(),
      side: side.slice(0, 1).toLowerCase(),
      size: data.map(({ size }) => size).reduce((stored, current) => stored + current),
      price,
      slippage: data.slice(1).map(({ price }) => price).reduce((stored, current) => {
          if ((stored[stored.length - 1] !== current) && (price !== current)) stored.push(current);

          return stored;
        }, [])
      };

    return result;
  }

  subscribe(symbol, handler) {
    symbol = String(symbol).toUpperCase();

    if (super.subscribe(symbol, handler) === 1) {
      this._socket.send(JSON.stringify({
        op: 'subscribe',
        args: [ `trade:${symbol}` ]
      }));
    }
  }

  unsubscribe(symbol, handler) {
    symbol = String(symbol).toUpperCase();

    const result = super.unsubscribe(symbol, handler);

    if (result === 0) {
      this._socket.send(JSON.stringify({
        op: 'unsubscribe',
        args: [ `trade:${symbol}` ]
      }));
    }
  }
}
class GDAXWS extends WSTracker {
  constructor() {
    super();

    if (GDAXWS._instance) {
      return GDAXWS._instance;
    }

    GDAXWS._instance = this;
    this._socket = new WebSocket('wss://ws-feed.gdax.com');
    this._setReady();
  }

  _formatData({ price, product_id, side, size, time, type }) {
    if (!['match', 'last_match'].includes(type)) return;

    return {
      symbol: product_id,
      time: (new Date(time)).getTime(),
      side: side === 'sell' ? 'b' : 's', // don't ask
      size: parseFloat(size, 10),
      price: parseFloat(price, 10),
      slippage: []
    };
  }

  subscribe(symbol, handler) {
    symbol = String(symbol).toUpperCase();

    if (super.subscribe(symbol, handler) === 1) {
      this._socket.send(JSON.stringify({
        type: 'subscribe',
        channels: [{ name: 'matches', product_ids: [ symbol ]}]
      }));
    }
  }

  unsubscribe(symbol, handler) {
    symbol = String(symbol).toUpperCase();

    const result = super.unsubscribe(symbol, handler);

    if (result === 0) {
      this._socket.send(JSON.stringify({
        type: 'unsubscribe',
        channels: [{ name: 'matches', product_ids: [ symbol ]}]
      }));
    }
  }
}

const exchangeData = {
  bitfinex: {
    caption: 'BitFinex',
    defaultSymbol: 'BTCUSD',
    ws: BitFinexWS,
    precision: {
      size: 8,
      price: 2,
    }
  },
  bitmex: {
    caption: 'BitMEX',
    defaultSymbol: 'XBTUSD',
    ws: BitMexWS,
    precision: {
      size: 2,
      price: 2,
    }
  },
  gdax: {
    caption: 'GDAX',
    defaultSymbol: 'BTC-USD',
    ws: GDAXWS,
    precision: {
      size: 8,
      price: 2,
    }
  },
  bitflyer: {
    caption: 'BitFlyer',
    defaultSymbol: 'BTC_JPY',
    ws: BitFlyerWS,
    precision: {
      size: 8,
      price: 2,
    }
  },
};

function momentDuration(string) {
  const match = /^([0-9]+)(\S)$/.exec(string);

  if (!match) return;

  const duration = [match[1], match[2]];
  const now = moment();

  return now.clone().add(...duration) > now ? duration : null;
}

class FeedConfig extends React.Component {
  state = {
    totalsPeriod: this.props.totalsPeriod,
    tradeTTL: this.props.tradeTTL,
  };

  defaults = { ...this.state };

  _onConfigChange() {
    this.props.onConfigChange({
      totalsPeriod: this.state.totalsPeriod,
      tradeTTL: this.state.tradeTTL,
    });
  }

  totalsPeriodChange({ type, target: { value }}) {
    if (type === 'blur') {
      if (momentDuration(value)) {
        this._onConfigChange();
      } else {
        this.setState({ totalsPeriod: this.props.totalsPeriod });
      }
    } else {
      this.setState({ totalsPeriod: value });
    }
  }

  tradeTTLChange({ type, target: { value }}) {
    if (type === 'blur') {
      if ((parseInt(value, 10) >= 0) || momentDuration(value)) {
        this._onConfigChange();
      } else {
        this.setState({ tradeTTL: this.props.tradeTTL });  
      }
    } else {
      this.setState({ tradeTTL: value });
    }
  }

  render() {
    const {
      totalsPeriod,
      tradeTTL,
      trades,
      precision,
    } = this.props;

    const totals = {
      buy: 0,
      sell: 0,
    };

    const duration = momentDuration(this.state.totalsPeriod);

    if (duration && (trades.length > 0)) {
      const until = moment(trades[0].time).subtract(...duration);

      trades.every(({ time, side, size }) => {
        if (until > moment(time)) return false;

        if (side === 'b') {
          totals.buy += size;
        } else {
          totals.sell += size;
        }

        return true;
      });
    }

    return (
      <div
        className="config"
      >
        <div
          className="totals-control"
        >
          <input
            type="text"
            placeholder={this.defaults.totalsPeriod}
            onChange={e => this.totalsPeriodChange(e)}
            onBlur={e => this.totalsPeriodChange(e)}
            value={this.state.totalsPeriod}
          />
          <abbr title="Enter a time spec like '5m' or '1h'">totals</abbr>
        </div>
        <div
         className="totals"
        >
          <div className="row">
            <div className="side">B:</div>{Number(precisionRound(totals.buy, precision)).toLocaleString()}
          </div>
          <div className="row">
            <div className="side">S:</div>{Number(precisionRound(totals.sell, precision)).toLocaleString()}
          </div>
        </div>
        <div
         className="ttl-control"
        >
          <abbr title="Enter a time spec ('1h', '5m') or a number of records, enter 0 to show all">Show records</abbr>
          <input
            type="text"
            placeholder={this.defaults.tradeTTL}
            onChange={e => this.tradeTTLChange(e)}
            onBlur={e => this.tradeTTLChange(e)}
            value={this.state.tradeTTL}
          />
        </div>
      </div>
    );
  }
}

function precisionRound(number, precision) {
  var factor = Math.pow(10, precision);

  return Math.round(number * factor) / factor;
}

class TradeTable extends React.Component {
  render() {
    const {
      useUTC,
      trades,
      precision,
    } = this.props;

    let average;
    let last;

    if (trades.length > 0) {
      average = trades.reduce((sizeTotal, trade) => sizeTotal += trade.size, 0) / trades.length;;
      last = trades[0].slippage[trades[0].slippage.length - 1] || trades[0].price;
    }

    return (
      <table
        className="trades"
      >
        <thead>
          <tr>
            <th className="time">Time ({useUTC ? 'UTC' : 'Local'})</th>
            <th className="side">
              Side
            </th>
            <th className="size">
              Size<br/>
              ({average ? <abbr title="Average order size">{precisionRound(average, precision.size)}</abbr> : 'Average'})
            </th>
            <th className="price">Price<br/>
              ({last ? <abbr title="Last match price">{precisionRound(last, precision.price)}</abbr> : 'Last'})
            </th>
          </tr>
        </thead>
        <tbody>
          {trades.map(({ time, side, size, price, slippage }, key, trades) => {
            time = moment.utc(time);

            if (!useUTC) time = time.local();

            const sizeFormatted = (size > 999 ? `${(size / 1000).toFixed(0)} K` : precisionRound(size, precision.size)).toLocaleString();
            let sizeTD;

            if (size > average) {
              sizeTD = (
                <td className="size"
                  style={{
                    backgroundColor:`rgba(${side === 'b' ? '0, 255': '255, 0'}, 0, ${0.3 + Math.min((Math.max(size / average - 2, 0) / 8) * 0.7, 0.7)})`, // size times average 2x to 10x gets converted to opacity of 0.3 to 1.0
                  }}
                >
                  <abbr
                    title={`${precisionRound(size / average, 2)}x average`}
                  >
                    {sizeFormatted}
                  </abbr>
                </td>
              );
            } else {
              sizeTD = <td className="size">{sizeFormatted}</td>
            }

            return (
              <tr
                key={key}
              >
                <td className="time">{time.format('HH:mm:ss.SSS')}{key < (trades.length - 1) ? ` (+${(time.valueOf() - trades[key + 1].time) / 1000})` : null}</td>
                <td className={`side${side === 'b' ? ' buy' : ' sell'}`}>{side.toUpperCase()}</td>
                {sizeTD}
                <td className="price">{slippage.length ? <abbr title={`Slipped from ${precisionRound(price, precision.price)}`}>{precisionRound(slippage[slippage.length - 1], precision.price)}</abbr> : precisionRound(price, precision.price)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
}

class Feed extends React.Component {
  state = {
    trades: [],
    totalsPeriod: '5m',
    tradeTTL: '10m',
    error: null,
  };

  _pruneTrades(trades, ttl) {
    let tradeTTL = ttl || this.state.tradeTTL;
    const duration = momentDuration(tradeTTL);

    if (duration) {
      if (trades.length === 0) return trades;

      const until = moment(trades[0].time).subtract(...duration);
      const firstOlder = trades.findIndex(({ time }) => until > moment(time));

      if (firstOlder !== -1) {
        trades.length = firstOlder;
      }

      return trades;
    } else if ((tradeTTL = parseInt(tradeTTL, 10)) > 0) {
      if (trades.length > tradeTTL) {
        trades.length = tradeTTL;
      }

      return trades;
    }

    return trades;
  }

  _handleConfigChange(config) {
    if (config.tradeTTL !== this.state.tradeTTL) {
      this.setState({ tradeTTL: config.tradeTTL });
      this.ws.tradeTTL = config.tradeTTL;
    }
  }

  componentDidMount() {
    const {
      exchange,
      symbol,
      minimum,
    } = this.props;

    const ws = this.ws = new exchangeData[exchange].ws();

    this._boundHandler = trades => this.setState({ trades });
    ws.ready.then(() =>  ws.subscribe(symbol, this._boundHandler));
  }

  componentWillUnmount() {
    this.ws.unsubscribe(this.props.symbol, this._boundHandler);
  }

  render() {
    const {
      exchange,
      symbol,
      minimum,
      useUTC,
      onRemove,
    } = this.props;

    const {
      trades,
    } = this.state;

    const {
      caption,
      precision,
    } = exchangeData[exchange];

    return (
      <div
        className="feed"
      >
        <div
          className="header"
        >
          <h3>{caption}: {symbol}{minimum ? ` >=${minimum}` : null}</h3>
          <button
            onClick={onRemove}
          >
            ❌
          </button>
        </div>
        <FeedConfig
          totalsPeriod={this.state.totalsPeriod}
          tradeTTL={this.state.tradeTTL}
          precision={precision.size}
          trades={trades}
          onConfigChange={config => this._handleConfigChange(config)}
        />
        <TradeTable
          useUTC={useUTC}
          precision={precision}
          trades={trades.filter(({ size }) => size >= minimum)}
        />
      </div>
    );
  }
}

class AddFeed extends React.Component {
  addClicked() {
    const values = {};

    Object.entries(this.refs).forEach(([key, input]) => values[key] = input.value);
    values.symbol = values.symbol.toUpperCase();
    this.props.addRequested(values);
  }

  render() {
    const defaultExchange = 'bitfinex';

    return (
      <span
        onKeyPress={({ key }) => (key === 'Enter') && this.addClicked()}
      >
        <select
          ref="exchange"
          defaultValue={defaultExchange}
          onChange={({ target: { value }}) => this.refs.symbol.value = exchangeData[value].defaultSymbol}
        >
          <option value="bitfinex">BitFinex</option>
          <option value="bitmex">BitMEX</option>
          <option value="gdax">GDAX</option>
          <option value="bitflyer">BitFlyer</option>
        </select>
        <input
          ref="symbol"
          type="text"
          placeholder="Symbol"
          defaultValue={exchangeData[defaultExchange].defaultSymbol}
        />
        <input
          ref="minimum"
          type="number"
          placeholder="Minimum order size"
        />
        <button
          onClick={() => this.addClicked()}
        >
          Add Feed
        </button>
      </span>
    );
  }
}

class App extends React.Component {
  state = {
    feeds: [],
    useUTC: false,
    errors: [],
  };

  _feedSequence = 0;

  componentDidCatch(error, info) {
    let errors = this.state.errors.slice();
    const index = errors.push(error) - 1;

    this.setState({ errors });

    setTimeout(() => {
      errors = errors.slice();
      errors.splice(index, 1);
      this.setState({ errors });
    }, 3000);
  }

  feedAddRequested(feedSpec) {
    const { feeds } = this.state;
    const minimum = parseFloat(feedSpec.minimum, 10);

    feedSpec.minimum = Number.isNaN(minimum) ? 0 : Math.abs(minimum);
    feeds.push({
      key: this._feedSequence++,
      ...feedSpec,
    });
    this.setState({ feeds });
  }

  render() {
    const {
      feeds,
      useUTC,
      errors,
    } = this.state;

    return (
      <div>
        <AddFeed
          addRequested={params => this.feedAddRequested(params)}
        />
        <label
          title="Uses UTC otherwise"
        >
          <input
            type="checkbox"
            onChange={e => this.setState({ useUTC: !e.target.checked })}
            checked
          />
          Use local time
        </label>
        <br/>
        {errors.map((error, key) => <span className="error" key={key}>{error.message}</span>)}
        <div
          className="feeds"
        >
          {feeds.map((feedSpec, key) => {
            return (
              <Feed
                {...feedSpec}
                useUTC={useUTC}
                onRemove={() => {
                  let tempFeeds = feeds.slice();

                  tempFeeds.splice(key, 1)
                  this.setState({ feeds: tempFeeds });
                }}
              />
            );
          })}
        </div>
      </div>
    );
  }
}

ReactDOM.render(<App />, document.getElementById('root'));
