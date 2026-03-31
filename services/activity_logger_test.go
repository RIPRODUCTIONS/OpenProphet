package services

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNewActivityLogger(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)
	if al == nil {
		t.Fatal("NewActivityLogger() returned nil")
	}
	if al.logDir != dir {
		t.Errorf("logDir = %q, want %q", al.logDir, dir)
	}
}

func TestStartSession(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)

	err := al.StartSession(context.Background(), 50000)
	if err != nil {
		t.Fatalf("StartSession() error = %v", err)
	}

	log, err := al.GetCurrentLog()
	if err != nil {
		t.Fatalf("GetCurrentLog() error = %v", err)
	}

	if log.Summary.StartingCapital != 50000 {
		t.Errorf("StartingCapital = %v, want 50000", log.Summary.StartingCapital)
	}
	if log.Date == "" {
		t.Error("Date should not be empty")
	}
	if log.SessionStart.IsZero() {
		t.Error("SessionStart should not be zero")
	}

	// Verify file was written
	filename := filepath.Join(dir, "activity_"+log.Date+".json")
	if _, err := os.Stat(filename); os.IsNotExist(err) {
		t.Errorf("log file not created: %s", filename)
	}
}

func TestEndSession(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)

	// End without start should error
	err := al.EndSession(context.Background(), 55000, 2)
	if err == nil {
		t.Error("EndSession() without start should error")
	}

	// Start then end
	al.StartSession(context.Background(), 50000)
	err = al.EndSession(context.Background(), 55000, 2)
	if err != nil {
		t.Fatalf("EndSession() error = %v", err)
	}

	log, _ := al.GetCurrentLog()
	if log.Summary.EndingCapital != 55000 {
		t.Errorf("EndingCapital = %v, want 55000", log.Summary.EndingCapital)
	}
	if log.Summary.ActivePositions != 2 {
		t.Errorf("ActivePositions = %d, want 2", log.Summary.ActivePositions)
	}
	if log.Summary.TotalPnL != 5000 {
		t.Errorf("TotalPnL = %v, want 5000", log.Summary.TotalPnL)
	}
	// PnL%: (5000/50000)*100 = 10%
	if log.Summary.TotalPnLPercent != 10.0 {
		t.Errorf("TotalPnLPercent = %v, want 10.0", log.Summary.TotalPnLPercent)
	}
	if log.SessionEnd.IsZero() {
		t.Error("SessionEnd should not be zero")
	}
}

func TestLogActivity(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)

	// Without session
	err := al.LogActivity("ANALYSIS", "Ran RSI", "AAPL", "checking momentum", nil)
	if err == nil {
		t.Error("LogActivity() without session should error")
	}

	al.StartSession(context.Background(), 50000)

	err = al.LogActivity("ANALYSIS", "Ran RSI", "AAPL", "checking momentum", map[string]interface{}{
		"rsi": 65.5,
	})
	if err != nil {
		t.Fatalf("LogActivity() error = %v", err)
	}

	log, _ := al.GetCurrentLog()
	if len(log.Activities) != 1 {
		t.Fatalf("Activities length = %d, want 1", len(log.Activities))
	}

	act := log.Activities[0]
	if act.Type != "ANALYSIS" {
		t.Errorf("Type = %q, want %q", act.Type, "ANALYSIS")
	}
	if act.Symbol != "AAPL" {
		t.Errorf("Symbol = %q, want %q", act.Symbol, "AAPL")
	}
	if act.Action != "Ran RSI" {
		t.Errorf("Action = %q, want %q", act.Action, "Ran RSI")
	}
	if act.Reasoning != "checking momentum" {
		t.Errorf("Reasoning = %q, want %q", act.Reasoning, "checking momentum")
	}
}

func TestLogPositionOpened(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)
	al.StartSession(context.Background(), 100000)

	err := al.LogPositionOpened("TSLA", "buy", 10, 250.0, 2500, 237.50, 275.0, 8, "bullish breakout", []string{"momentum", "breakout"})
	if err != nil {
		t.Fatalf("LogPositionOpened() error = %v", err)
	}

	log, _ := al.GetCurrentLog()
	if len(log.PositionsOpened) != 1 {
		t.Fatalf("PositionsOpened length = %d, want 1", len(log.PositionsOpened))
	}

	pos := log.PositionsOpened[0]
	if pos.Symbol != "TSLA" {
		t.Errorf("Symbol = %q, want TSLA", pos.Symbol)
	}
	if pos.Quantity != 10 {
		t.Errorf("Quantity = %v, want 10", pos.Quantity)
	}
	if pos.EntryPrice != 250.0 {
		t.Errorf("EntryPrice = %v, want 250.0", pos.EntryPrice)
	}
	if pos.Conviction != 8 {
		t.Errorf("Conviction = %d, want 8", pos.Conviction)
	}
	if len(pos.Tags) != 2 {
		t.Errorf("Tags length = %d, want 2", len(pos.Tags))
	}

	// Summary should be updated
	if log.Summary.PositionsOpened != 1 {
		t.Errorf("Summary.PositionsOpened = %d, want 1", log.Summary.PositionsOpened)
	}
	if log.Summary.TotalTrades != 1 {
		t.Errorf("Summary.TotalTrades = %d, want 1", log.Summary.TotalTrades)
	}
	if log.Summary.CapitalDeployed != 2500 {
		t.Errorf("Summary.CapitalDeployed = %v, want 2500", log.Summary.CapitalDeployed)
	}
}

func TestLogPositionClosed(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)
	al.StartSession(context.Background(), 100000)

	t.Run("winning long trade", func(t *testing.T) {
		err := al.LogPositionClosed("AAPL", "buy", 20, 150, 165, 3000, 5, "target hit", []string{"swing"})
		if err != nil {
			t.Fatalf("LogPositionClosed() error = %v", err)
		}

		log, _ := al.GetCurrentLog()
		pos := log.PositionsClosed[0]

		// PnL = (165-150)*20 = 300
		if pos.PnL != 300 {
			t.Errorf("PnL = %v, want 300", pos.PnL)
		}
		// PnL% = (165-150)/150*100 = 10%
		if pos.PnLPercent != 10.0 {
			t.Errorf("PnLPercent = %v, want 10.0", pos.PnLPercent)
		}
		if log.Summary.WinningTrades != 1 {
			t.Errorf("WinningTrades = %d, want 1", log.Summary.WinningTrades)
		}
		if log.Summary.LargestWin != 300 {
			t.Errorf("LargestWin = %v, want 300", log.Summary.LargestWin)
		}
	})

	t.Run("losing long trade", func(t *testing.T) {
		err := al.LogPositionClosed("TSLA", "buy", 5, 200, 180, 1000, 3, "stop hit", nil)
		if err != nil {
			t.Fatalf("LogPositionClosed() error = %v", err)
		}

		log, _ := al.GetCurrentLog()
		pos := log.PositionsClosed[1]

		// PnL = (180-200)*5 = -100
		if pos.PnL != -100 {
			t.Errorf("PnL = %v, want -100", pos.PnL)
		}
		if log.Summary.LosingTrades != 1 {
			t.Errorf("LosingTrades = %d, want 1", log.Summary.LosingTrades)
		}
		if log.Summary.LargestLoss != -100 {
			t.Errorf("LargestLoss = %v, want -100", log.Summary.LargestLoss)
		}
	})

	t.Run("winning short trade", func(t *testing.T) {
		err := al.LogPositionClosed("SPY", "sell", 10, 500, 480, 5000, 2, "covered", nil)
		if err != nil {
			t.Fatalf("LogPositionClosed() error = %v", err)
		}

		log, _ := al.GetCurrentLog()
		pos := log.PositionsClosed[2]

		// Short PnL = (500-480)*10 = 200
		if pos.PnL != 200 {
			t.Errorf("Short PnL = %v, want 200", pos.PnL)
		}
		// Short PnL% = (500-480)/500*100 = 4%
		if pos.PnLPercent != 4.0 {
			t.Errorf("Short PnLPercent = %v, want 4.0", pos.PnLPercent)
		}
	})
}

func TestLogIntelligence(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)
	al.StartSession(context.Background(), 50000)

	// NEWS source
	al.LogIntelligence("NEWS", "Fed Rate Decision", "Fed holds rates steady", []string{"SPY", "QQQ"})
	log, _ := al.GetCurrentLog()
	if log.Summary.NewsArticlesRead != 1 {
		t.Errorf("NewsArticlesRead = %d, want 1", log.Summary.NewsArticlesRead)
	}

	// WEBSEARCH source
	al.LogIntelligence("WEBSEARCH", "TSLA earnings", "Beat estimates", []string{"TSLA"})
	log, _ = al.GetCurrentLog()
	if log.Summary.WebSearches != 1 {
		t.Errorf("WebSearches = %d, want 1", log.Summary.WebSearches)
	}

	if len(log.MarketIntelligence) != 2 {
		t.Errorf("MarketIntelligence length = %d, want 2", len(log.MarketIntelligence))
	}
}

func TestLogDecision(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)
	al.StartSession(context.Background(), 50000)

	err := al.LogDecision("BUY", "NVDA", "strong momentum + AI tailwinds", 9, map[string]interface{}{
		"rsi": 55.0,
		"sma20": 130.0,
	})
	if err != nil {
		t.Fatalf("LogDecision() error = %v", err)
	}

	log, _ := al.GetCurrentLog()
	if len(log.Decisions) != 1 {
		t.Fatalf("Decisions length = %d, want 1", len(log.Decisions))
	}

	dec := log.Decisions[0]
	if dec.Action != "BUY" {
		t.Errorf("Action = %q, want BUY", dec.Action)
	}
	if dec.Conviction != 9 {
		t.Errorf("Conviction = %d, want 9", dec.Conviction)
	}
}

func TestLogStocksAnalyzed(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)
	al.StartSession(context.Background(), 50000)

	al.LogStocksAnalyzed(15)
	al.LogStocksAnalyzed(10)

	log, _ := al.GetCurrentLog()
	if log.Summary.StocksAnalyzed != 25 {
		t.Errorf("StocksAnalyzed = %d, want 25", log.Summary.StocksAnalyzed)
	}
}

func TestGetLogForDate(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)
	al.StartSession(context.Background(), 50000)

	log, _ := al.GetCurrentLog()
	date := log.Date

	// Retrieve the saved log by date
	retrieved, err := al.GetLogForDate(date)
	if err != nil {
		t.Fatalf("GetLogForDate() error = %v", err)
	}
	if retrieved.Summary.StartingCapital != 50000 {
		t.Errorf("StartingCapital = %v, want 50000", retrieved.Summary.StartingCapital)
	}

	// Non-existent date
	_, err = al.GetLogForDate("1999-01-01")
	if err == nil {
		t.Error("GetLogForDate() should error for non-existent date")
	}
}

func TestListAvailableLogs(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)

	// Create a few log files
	al.StartSession(context.Background(), 50000)

	dates, err := al.ListAvailableLogs()
	if err != nil {
		t.Fatalf("ListAvailableLogs() error = %v", err)
	}
	if len(dates) < 1 {
		t.Error("ListAvailableLogs() should return at least 1 date")
	}
}

func TestSaveLogPersistence(t *testing.T) {
	dir := t.TempDir()
	al := NewActivityLogger(dir)
	al.StartSession(context.Background(), 75000)
	al.LogActivity("ANALYSIS", "scan", "AAPL", "daily scan", nil)
	al.LogPositionOpened("AAPL", "buy", 5, 180, 900, 171, 198, 7, "breakout", nil)

	log, _ := al.GetCurrentLog()

	// Read the file back directly to verify JSON structure
	filename := filepath.Join(dir, "activity_"+log.Date+".json")
	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatalf("failed to read log file: %v", err)
	}

	var parsed DailyActivityLog
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to parse log JSON: %v", err)
	}

	if parsed.Summary.StartingCapital != 75000 {
		t.Errorf("persisted StartingCapital = %v, want 75000", parsed.Summary.StartingCapital)
	}
	if len(parsed.Activities) != 1 {
		t.Errorf("persisted Activities length = %d, want 1", len(parsed.Activities))
	}
	if len(parsed.PositionsOpened) != 1 {
		t.Errorf("persisted PositionsOpened length = %d, want 1", len(parsed.PositionsOpened))
	}
}

func TestGetCurrentLog_NoSession(t *testing.T) {
	al := NewActivityLogger(t.TempDir())
	_, err := al.GetCurrentLog()
	if err == nil {
		t.Error("GetCurrentLog() without session should error")
	}
}
