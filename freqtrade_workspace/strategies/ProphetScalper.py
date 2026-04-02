"""
ProphetScalper — Freqtrade strategy that mirrors OpenProphet's crypto-scalper preset.

Targets 1-3% gains on 5m timeframes with tight risk management.
Uses EMA crossover + RSI + volume confirmation.
"""
from freqtrade.strategy import IStrategy, DecimalParameter, IntParameter
from pandas import DataFrame
import talib.abstract as ta


class ProphetScalper(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "5m"

    # Risk
    minimal_roi = {"0": 0.03, "30": 0.02, "60": 0.01, "120": 0}
    stoploss = -0.02
    trailing_stop = True
    trailing_stop_positive = 0.01
    trailing_stop_positive_offset = 0.015
    trailing_only_offset_is_reached = True

    # Position sizing
    position_adjustment_enable = False
    max_entry_position_adjustment = 0

    # Hyperoptable parameters
    buy_rsi = IntParameter(20, 50, default=44, space="buy")
    buy_ema_short = IntParameter(5, 15, default=10, space="buy")
    buy_ema_long = IntParameter(15, 30, default=25, space="buy")
    sell_rsi = IntParameter(55, 85, default=61, space="sell")
    volume_factor = DecimalParameter(1.0, 3.0, default=2.0, decimals=1, space="buy")

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # EMAs
        dataframe["ema_8"] = ta.EMA(dataframe, timeperiod=self.buy_ema_short.value)
        dataframe["ema_21"] = ta.EMA(dataframe, timeperiod=self.buy_ema_long.value)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)

        # RSI
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)

        # Volume
        dataframe["volume_mean"] = dataframe["volume"].rolling(20).mean()

        # MACD
        macd = ta.MACD(dataframe, fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe["macd"] = macd["macd"]
        dataframe["macdsignal"] = macd["macdsignal"]

        # Bollinger Bands
        bollinger = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.0, nbdevdn=2.0)
        dataframe["bb_lower"] = bollinger["lowerband"]
        dataframe["bb_upper"] = bollinger["upperband"]
        dataframe["bb_mid"] = bollinger["middleband"]

        # ATR for volatility
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["ema_8"] > dataframe["ema_21"])
                & (dataframe["rsi"] < self.buy_rsi.value)
                & (dataframe["volume"] > dataframe["volume_mean"] * self.volume_factor.value)
                & (dataframe["close"] > dataframe["ema_50"])
                & (dataframe["macd"] > dataframe["macdsignal"])
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["rsi"] > self.sell_rsi.value)
                | (dataframe["ema_8"] < dataframe["ema_21"])
                | (dataframe["close"] > dataframe["bb_upper"])
            ),
            "exit_long",
        ] = 1
        return dataframe
