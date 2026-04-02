"""
ProphetAI — FreqAI-powered strategy using LightGBM classifier.

Uses machine learning to predict entry/exit signals based on 100+ technical
features across multiple timeframes. FreqAI trains the model on rolling windows
and retrains automatically as new data arrives.

Requires: freqai.enabled=true in config, lightgbm installed.
"""
from freqtrade.strategy import IStrategy, DecimalParameter, IntParameter
from pandas import DataFrame
import talib.abstract as ta
import numpy as np
import logging

logger = logging.getLogger(__name__)


class ProphetAI(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "15m"

    # Let FreqAI handle most decisions; ROI is a safety net
    minimal_roi = {"0": 0.10, "120": 0.05, "360": 0.02, "720": 0}
    stoploss = -0.08
    trailing_stop = True
    trailing_stop_positive = 0.02
    trailing_stop_positive_offset = 0.04
    trailing_only_offset_is_reached = True

    max_open_trades = 5
    use_exit_signal = True

    # FreqAI confidence thresholds
    buy_threshold = DecimalParameter(0.55, 0.80, default=0.65, decimals=2, space="buy")
    sell_threshold = DecimalParameter(0.55, 0.80, default=0.60, decimals=2, space="sell")

    def feature_engineering_expand_all(self, dataframe: DataFrame, period: int,
                                        metadata: dict, **kwargs) -> DataFrame:
        """
        Features expanded across all timeframes and corr pairs.
        FreqAI calls this for each timeframe in include_timeframes.
        """
        dataframe["%-rsi-period"] = ta.RSI(dataframe, timeperiod=period)
        dataframe["%-mfi-period"] = ta.MFI(dataframe, timeperiod=period)
        dataframe["%-adx-period"] = ta.ADX(dataframe, timeperiod=period)
        dataframe["%-cci-period"] = ta.CCI(dataframe, timeperiod=period)

        # Momentum
        dataframe["%-roc-period"] = ta.ROC(dataframe, timeperiod=period)
        dataframe["%-willr-period"] = ta.WILLR(dataframe, timeperiod=period)

        # Volatility
        bb = ta.BBANDS(dataframe, timeperiod=period, nbdevup=2.0, nbdevdn=2.0)
        dataframe["%-bb-width-period"] = (bb["upperband"] - bb["lowerband"]) / bb["middleband"]
        dataframe["%-bb-position-period"] = (
            (dataframe["close"] - bb["lowerband"]) / 
            (bb["upperband"] - bb["lowerband"]).replace(0, np.nan)
        )
        dataframe["%-atr-period"] = ta.ATR(dataframe, timeperiod=period) / dataframe["close"]

        # Trend
        dataframe["%-ema-period"] = ta.EMA(dataframe, timeperiod=period) / dataframe["close"]
        dataframe["%-sma-period"] = ta.SMA(dataframe, timeperiod=period) / dataframe["close"]

        return dataframe

    def feature_engineering_expand_basic(self, dataframe: DataFrame,
                                          metadata: dict, **kwargs) -> DataFrame:
        """Features expanded only on base timeframe."""
        # MACD
        macd = ta.MACD(dataframe, fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe["%-macd"] = macd["macd"]
        dataframe["%-macd-signal"] = macd["macdsignal"]
        dataframe["%-macd-hist"] = macd["macdhist"]

        # Stochastic
        stoch = ta.STOCH(dataframe)
        dataframe["%-stoch-k"] = stoch["slowk"]
        dataframe["%-stoch-d"] = stoch["slowd"]

        # Volume features
        dataframe["%-volume-ratio"] = dataframe["volume"] / dataframe["volume"].rolling(20).mean()
        dataframe["%-volume-pct-change"] = dataframe["volume"].pct_change(5)

        # Price action
        dataframe["%-pct-change"] = dataframe["close"].pct_change()
        dataframe["%-pct-change-5"] = dataframe["close"].pct_change(5)
        dataframe["%-pct-change-10"] = dataframe["close"].pct_change(10)

        # Candle patterns
        dataframe["%-body-ratio"] = abs(dataframe["close"] - dataframe["open"]) / (
            (dataframe["high"] - dataframe["low"]).replace(0, np.nan)
        )
        dataframe["%-upper-shadow"] = (dataframe["high"] - dataframe[["close", "open"]].max(axis=1)) / (
            (dataframe["high"] - dataframe["low"]).replace(0, np.nan)
        )

        return dataframe

    def feature_engineering_standard(self, dataframe: DataFrame,
                                      metadata: dict, **kwargs) -> DataFrame:
        """Non-expanded features — computed once."""
        dataframe["%-day-of-week"] = dataframe["date"].dt.dayofweek
        dataframe["%-hour-of-day"] = dataframe["date"].dt.hour
        return dataframe

    def set_freqai_targets(self, dataframe: DataFrame,
                            metadata: dict, **kwargs) -> DataFrame:
        """Define what the model should predict."""
        # Binary classification: will price go up by >0.5% in next 24 candles (6h)?
        dataframe["&s-up_or_down"] = np.where(
            dataframe["close"].shift(-24) > dataframe["close"] * 1.005, 1, 0
        )
        return dataframe

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # FreqAI handles all indicator/feature computation
        dataframe = self.freqai.start(dataframe, metadata, self)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Use FreqAI prediction confidence
        dataframe.loc[
            (
                (dataframe["&s-up_or_down"] == 1)
                & (dataframe["do_predict"] == 1)  # FreqAI confidence check
                & (dataframe["volume"] > 0)
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "freqai_buy")

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["&s-up_or_down"] == 0)
                & (dataframe["do_predict"] == 1)
            ),
            ["exit_long", "exit_tag"],
        ] = (1, "freqai_exit")

        return dataframe
