(function () {
    'use strict';

    /**
     * @param {BaseNodeComponent} BaseNodeComponent
     * @param {app.utils} utils
     * @param {User} user
     * @param {EventManager} eventManager
     * @param {app.utils.decorators} decorators
     * @param {PollCache} PollCache
     * @param {Aliases} aliases
     * @param {Matcher} matcher
     * @param {Cache} Cache
     * @return {Assets}
     */
    const factory = function (BaseNodeComponent, utils, user, eventManager, decorators, PollCache, aliases, matcher, Cache) {

        class Assets extends BaseNodeComponent {

            constructor() {
                super();
                /**
                 * @type {Cache}
                 * @private
                 */
                this._assets = new Cache();
                user.onLogin().then(() => {
                    this._balanceCache = new PollCache({
                        getData: this._getBalances.bind(this),
                        timeout: 2000,
                        isBalance: true
                    });
                });
            }

            /**
             * Get Asset info
             * @param {string} assetId
             * @return {Promise<Asset>}
             */
            info(assetId) {
                const cached = this._assets.get(assetId);

                if (cached) {
                    return Promise.resolve(cached);
                }

                return Waves.Asset.get(assetId).then((info) => {
                    this._assets.set(assetId, info);
                    return info;
                });
            }

            /**
             * Get balance by asset id
             * @param {string} assetId
             * @return {Promise<IBalanceDetails>}
             */
            balance(assetId) {
                return this.balanceList([assetId])
                    .then(([asset]) => asset);
            }

            /**
             * @param {string} query
             * @return {JQuery.jqXHR}
             */
            search(query) {
                return $.get(`https://api.wavesplatform.com/assets/search/${query}`, (data) => {
                    return data.map((item) => {
                        item.name = WavesApp.remappedAssetNames[item.id] || item.name;
                        return item;
                    });
                });
            }

            /**
             * Get balance list by asset id list
             * @param {string[]} assetIdList
             * @return {Promise<IBalanceDetails[]>}
             */
            balanceList(assetIdList) {
                return utils.whenAll([this.userBalances(), this._getEmptyBalanceList(assetIdList)])
                    .then(([balanceList, emptyBalanceList]) => {
                        const balances = utils.toHash(balanceList, 'available.asset.id');
                        return emptyBalanceList.map((money) => {
                            if (balances[money.asset.id]) {
                                return balances[money.asset.id];
                            } else {
                                return {
                                    asset: money.asset,
                                    regular: money,
                                    available: money,
                                    inOrders: money,
                                    leasedOut: money,
                                    leasedIn: money
                                };
                            }
                        });
                    });
            }

            /**
             * Get balance list by user address
             * @return {Promise<IBalanceDetails[]>}
             */
            userBalances() {
                return user.onLogin().then(() => this._balanceCache.get());
            }

            /**
             * Get list of min values fee
             * @param {string} type
             * @return {Promise<Money[]>}
             */
            fee(type) {
                return this._feeList(type);
            }

            /**
             * Create transfer transaction
             * @param {Money} amount
             * @param {Money} [fee]
             * @param {string} recipient
             * @param {string} attachment
             * @param {string} keyPair
             * @return {Promise<{id: string}>}
             */
            transfer({ amount, fee, recipient, attachment, keyPair }) {
                return this.getFee('transfer', fee)
                    .then((fee) => {
                        return Waves.API.Node.v1.assets.transfer({
                            amount: amount.toCoins(),
                            assetId: amount.asset.id,
                            fee: fee.toCoins(),
                            feeAssetId: fee.asset.id,
                            recipient,
                            attachment
                        }, keyPair)
                            .then(this._pipeTransaction([amount, fee]));
                    });
            }

            /**
             * Create issue transaction
             * @param {string} name
             * @param {string} description
             * @param {BigNumber} quantity count of tokens from new asset
             * @param {number} precision num in range from 0 to 8
             * @param {boolean} reissuable can reissue token
             * @param {Seed.keyPair} keyPair
             * @param {Money} [fee]
             * @return {Promise<ITransaction>}
             */
            issue({ name, description, quantity, precision, reissuable, fee, keyPair }) {
                const coins = quantity.mul(Math.pow(10, precision)).toFixed();
                return this.getFee('issue', fee).then((fee) => {
                    return Waves.API.Node.v1.assets.issue({
                        name,
                        description,
                        precision,
                        reissuable,
                        quantity: coins,
                        fee
                    }, keyPair)
                        .then(this._pipeTransaction([fee]));
                });
            }

            /**
             * Create reissue transaction
             */
            reissue({ quantity, reissuable, fee, keyPair }) {
                return this.getFee('reissue', fee).then((fee) => Waves.API.Node.v1.assets.reissue({
                    assetId: quantity.asset.id,
                    fee: fee.toCoins(),
                    quantity: quantity.toCoins(),
                    reissuable
                }, keyPair));
            }

            /**
             * Create burn transaction
             */
            burn({ quantity, fee, keyPair }) {
                return this.getFee('burn', fee).then((fee) => Waves.API.Node.v1.assets.burn({
                    quantity: quantity.toCoins(),
                    fee: fee.toCoins(),
                    assetId: quantity.asset.id
                }, keyPair));
            }

            distribution() {

            }

            /**
             * @private
             */
            _getBalanceOrders() {
                return matcher.getOrders()
                    .then((orders) => orders.filter(Assets._filterOrders))
                    .then((orders) => orders.map(Assets._remapOrders));
            }

            /**
             * @return {Promise<Response>}
             * @private
             */
            _getUserAssetBalances() {
                return fetch(`${user.getSetting('network.node')}/assets/balance/${user.address}`)
                    .then(utils.onFetch)
                    .then(({ balances }) => this._remapBalanceList(balances));
            }

            /**
             * @return {Promise<IBalanceDetails[]>}
             * @private
             */
            _getBalances() {
                return Promise.all([
                    Waves.API.Node.v2.addresses.get(user.address),
                    this._getUserAssetBalances(),
                    this._getBalanceOrders()
                ]).then(Assets._remapBalance);
            }

            /**
             * @param {string[]} idList
             * @returns {Promise<any[]>}
             * @private
             */
            _getEmptyBalanceList(idList) {
                return Promise.all(idList.map((id) => Waves.Money.fromCoins('0', id)));
            }

            /**
             * @param balances
             * @return {Promise<Money[]>}
             * @private
             */
            _remapBalanceList(balances) {
                return Promise.all(balances.map((balance) => {
                    const id = balance.assetId;
                    const cached = this._assets.get(id);

                    const _create = (asset) => {
                        const divider = new BigNumber(10).pow(balance.issueTransaction.decimals);
                        const quantity = new BigNumber(balance.quantity).div(divider);
                        const reissuable = balance.reissuable;

                        this._assets.update(asset.id, { quantity, reissuable });

                        return Promise.resolve(new Waves.Money(String(balance.balance), asset));
                    };

                    if (cached) {
                        return Promise.resolve(_create(cached));
                    } else {
                        return this.info(id).then(_create);
                    }
                }));
            }

            /**
             * @param order
             * @returns {*}
             * @private
             */
            static _remapOrders(order) {
                switch (order.type) {
                    case 'sell':
                        return order.amount.sub(order.filled);
                    case 'buy':
                        const tokens = order.amount.sub(order.filled).getTokens().mul(order.price.getTokens());
                        return order.price.cloneWithTokens(tokens);
                }
            }

            /**
             * @param {string} status
             * @return {boolean}
             * @private
             */
            static _filterOrders({ status }) {
                return status === 'Accepted' || status === 'PartiallyFilled';
            }

            /**
             * @param wavesDetails
             * @param moneyList
             * @param orderMoneyList
             * @return {IBalanceDetails[]}
             * @private
             */
            static _remapBalance([wavesDetails, moneyList, orderMoneyList]) {
                const orderMoneyHash = utils.groupMoney(orderMoneyList);
                const eventsMoneyHash = utils.groupMoney(eventManager.getReservedMoneyList());

                const wavesNodeRegular = wavesDetails.wavesBalance.regular;
                const wavesNodeAvailable = wavesDetails.wavesBalance.available;
                const wavesTx = eventsMoneyHash[WavesApp.defaultAssets.WAVES] || wavesNodeRegular.cloneWithCoins('0');
                const wavesOrder = orderMoneyHash[WavesApp.defaultAssets.WAVES] || wavesNodeRegular.cloneWithCoins('0');

                aliases.aliases = wavesDetails.aliases;

                return [{
                    asset: wavesNodeRegular.asset,
                    regular: Assets._getMoneySub(wavesNodeRegular, wavesTx),
                    available: Assets._getMoneySub(wavesNodeAvailable, wavesTx, wavesOrder),
                    inOrders: wavesOrder,
                    leasedOut: wavesDetails.wavesBalance.leasedOut,
                    leasedIn: wavesDetails.wavesBalance.leasedIn
                }].concat(moneyList.slice(1).map(Assets._remapAssetsMoney(orderMoneyHash, eventsMoneyHash)));
            }

            /**
             * @param orderMoneyHash
             * @param eventsMoneyHash
             * @return {Function}
             * @private
             */
            static _remapAssetsMoney(orderMoneyHash, eventsMoneyHash) {
                return function (money) {
                    const eventsMoney = eventsMoneyHash[money.asset.id] || money.cloneWithCoins('0');
                    const inOrders = orderMoneyHash[money.asset.id] || money.cloneWithCoins('0');

                    return {
                        asset: money.asset,
                        regular: Assets._getMoneySub(money, eventsMoney),
                        available: Assets._getMoneySub(money, eventsMoney, inOrders),
                        inOrders,
                        leasedOut: money.cloneWithCoins('0'),
                        leasedIn: money.cloneWithCoins('0')
                    };
                };
            }

            /**
             *
             * @param {Money} money
             * @param {Money[]} toSubMoneyList
             * @return {*}
             * @private
             */
            static _getMoneySub(money, ...toSubMoneyList) {
                const result = toSubMoneyList.reduce((result, toSub) => {
                    return result.sub(toSub);
                }, money);
                if (result.getTokens().lt(0)) {
                    return result.cloneWithCoins('0');
                } else {
                    return result;
                }
            }

        }

        return utils.bind(new Assets());
    };

    factory.$inject = [
        'BaseNodeComponent',
        'utils',
        'user',
        'eventManager',
        'decorators',
        'PollCache',
        'aliases',
        'matcher',
        'Cache'
    ];

    angular.module('app')
        .factory('assets', factory);
})();

/**
 * @typedef {object} IBalanceDetails
 * @property {Asset} asset
 * @property {Money} regular
 * @property {Money} available
 * @property {Money} inOrders
 * @property {Money} leasedOut
 * @property {Money} leasedIn
 */
