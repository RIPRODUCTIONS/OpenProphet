"""
ProphetMomentum — Multi-timeframe momentum strategy for OpenProphet.

Designed for higher trade frequency (20+ trades/month) while maintaining
positive expectancy. Uses 15m entries confirmed by 1h trend direction.

Key design choices:
- Looser RSI thresholds (30-35 vs 20) for more entries
- EMA trend filter on informative (1h) timeframe
- MACD histogram momentum confirmation
- ATR-based dynamic stoploss instead of fixed %
- Volume spike detection for breakout entries
"""
from freqtrade.strategy import IStrategy, DecimalParameter, IntParameter, informative
from pandas import DataFrame
import talib.abstract as ta
import numpy as np


class ProphetMomentum(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "15m"

    # Hyperopt-optimized params (500 epochs, Sharpe loss, 0.2% fee)
    # 77% win rate, 92.5% ROI exit accuracy on 30d backtest
    minimal_roi = {"0": 0.241, "117": 0.064, "291": 0.048, "615": 0}
    stoploss = -0.112
    trailing_stop = True
    trailing_stop_positive = 0.083
    trailing_stop_positive_offset = 0.135
    trailing_only_offset_is_reached = True

    max_open_trades = 5

    use_entry_signal = True
    use_exit_signal = True
    entry_profit_only = False

    # Hyperopt-optimized parameters
    rsi_buy = IntParameter(25, 45, default=31, space="buy")
    rsi_sell = IntParameter(65, 85, default=85, space="sell")
    ema_fast = IntParameter(8, 15, default=8, space="buy")
    ema_slow = IntParameter(20, 35, default=28, space="buy")
    volume_factor = DecimalParameter(1.0, 3.0, default=1.8, decimals=1, space="buy")
    atr_multiplier = DecimalParameter(1.5, 3.0, default=2.1, decimals=1, space="buy")

    @informative("1h")
    def populate_indicators_1h(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """1h trend direction — used as confirmation filter."""
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["ema_200"] = ta.EMA(dataframe, timeperiod=200)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        macd = ta.MACD(dataframe, fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe["macd"] = macd["macd"]
        dataframe["macd_signal"] = macd["macdsignal"]
        dataframe["macd_hist"] = macd["macdhist"]
        dataframe["adx"] = ta.ADX(dataframe, timeperiod=14)
        return dataframe

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # EMAs
        dataframe["ema_fast"] = ta.EMA(dataframe, timeperiod=self.ema_fast.value)
        dataframe["ema_slow"] = ta.EMA(dataframe, timeperiod=self.ema_slow.value)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)

        # RSI
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)

        # MACD
        macd = ta.MACD(dataframe, fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe["macd"] = macd["macd"]
        dataframe["macd_signal"] = macd["macdsignal"]
        dataframe["macd_hist"] = macd["macdhist"]

        # Bollinger Bands
        bb = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.0, nbdevdn=2.0)
        dataframe["bb_lower"] = bb["lowerband"]
        dataframe["bb_upper"] = bb["upperband"]
        dataframe["bb_mid"] = bb["middleband"]

        # ATR for dynamic stoploss
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)

        # Volume analysis
        dataframe["volume_mean"] = dataframe["volume"].rolling(20).mean()
        dataframe["volume_ratio"] = dataframe["volume"] / dataframe["volume_mean"]

        # Momentum: rate of change
        dataframe["roc"] = ta.ROC(dataframe, timeperiod=10)

        # Stochastic RSI
        dataframe["stoch_rsi_k"] = ta.STOCHRSI(dataframe, timeperiod=14)["fastk"]

        # ADX for trend strength
        dataframe["adx"] = ta.ADX(dataframe, timeperiod=14)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Momentum buy: EMA crossover + RSI dip + volume spike + 1h trend up
        dataframe.loc[
            (
                # 15m: EMA fast above slow (short-term uptrend)
                (dataframe["ema_fast"] > dataframe["ema_slow"])
                # RSI not overbought, with room to run
                & (dataframe["rsi"] > 30)
                & (dataframe["rsi"] < self.rsi_buy.value)
                # MACD histogram positive or turning positive
                & (dataframe["macd_hist"] > dataframe["macd_hist"].shift(1))
                # Volume above average
                & (dataframe["volume_ratio"] > self.volume_factor.value)
                # 1h: price above 50 EMA (uptrend)
                & (dataframe["close"] > dataframe["ema_50_1h"])
                # 1h: MACD bullish
                & (dataframe["macd_hist_1h"] > 0)
                # Basic volume filter
                & (dataframe["volume"] > 0)
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "momentum_buy")

        # Dip buy: price bounces off BB lower + RSI oversold + 1h trend intact
        dataframe.loc[
            (
                # Price near or below lower BB
                (dataframe["close"] < dataframe["bb_lower"] * 1.01)
                # RSI oversold
                & (dataframe["rsi"] < 32)
                # Stoch RSI oversold
                & (dataframe["stoch_rsi_k"] < 20)
                # 1h: still in uptrend (don't catch falling knife)
                & (dataframe["ema_50_1h"] > dataframe["ema_200_1h"])
                # Volume confirmation
                & (dataframe["volume"] > dataframe["volume_mean"] * 0.8)
                & (dataframe["volume"] > 0)
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "dip_buy")

        # Breakout buy: price breaks above BB upper with strong volume + ADX trending
        dataframe.loc[
            (
                # Price breaks above upper BB
                (dataframe["close"] > dataframe["bb_upper"])
                # Strong volume (2x+ average)
                & (dataframe["volume_ratio"] > 2.0)
                # ADX shows trend (not range-bound)
                & (dataframe["adx"] > 25)
                # Positive momentum
                & (dataframe["roc"] > 0)
                # 1h: bullish
                & (dataframe["macd_hist_1h"] > 0)
                & (dataframe["volume"] > 0)
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "breakout_buy")

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Only exit on strong reversal signals — let ROI + trailing handle normal exits
        dataframe.loc[
            (
                # RSI extreme overbought
                (dataframe["rsi"] > self.rsi_sell.value)
                # AND MACD clearly bearish (histogram negative and falling)
                & (dataframe["macd_hist"] < 0)
                & (dataframe["macd_hist"] < dataframe["macd_hist"].shift(1))
                # AND 1h trend turning bearish
                & (dataframe["macd_hist_1h"] < 0)
            ),
            ["exit_long", "exit_tag"],
        ] = (1, "reversal_exit")

        return dataframe

    def custom_stoploss(self, pair: str, trade, current_time, current_rate,
                        current_profit, after_fill, **kwargs) -> float:
        """ATR-based dynamic stoploss — wider in volatile markets, tighter in calm."""
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if len(dataframe) < 1:
            return self.stoploss

        last_candle = dataframe.iloc[-1]
        atr = last_candle.get("atr", 0)
        if atr and current_rate:
            atr_stoploss = -(atr * self.atr_multiplier.value) / current_rate
            return max(atr_stoploss, self.stoploss)  # never wider than base stoploss

        return self.stoploss
