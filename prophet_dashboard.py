#!/usr/bin/env python3
"""
Prophet Trading Dashboard
Monitors OpenProphet API and provides trading insights
"""
import asyncio
import aiohttp
import json
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ProphetDashboard:
    def __init__(self):
        self.base_url = "http://localhost:3737"
        self.session = None
        self.account_data = {}
        self.positions = []
        self.activity = []
        
    async def __aenter__(self):
        self.session = aiohttp.ClientSession()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()
    
    async def fetch_account_data(self) -> Dict:
        """Fetch account information"""
        try:
            async with self.session.get(f"{self.base_url}/api/v1/account") as resp:
                if resp.status == 200:
                    self.account_data = await resp.json()
                    return self.account_data
        except Exception as e:
            logger.error(f"Failed to fetch account data: {e}")
        return {}
    
    async def fetch_positions(self) -> List[Dict]:
        """Fetch current positions"""
        try:
            async with self.session.get(f"{self.base_url}/api/v1/positions") as resp:
                if resp.status == 200:
                    self.positions = await resp.json()
                    return self.positions
        except Exception as e:
            logger.error(f"Failed to fetch positions: {e}")
        return []
    
    async def fetch_activity(self) -> List[Dict]:
        """Fetch recent trading activity"""
        try:
            async with self.session.get(f"{self.base_url}/api/v1/activity/current") as resp:
                if resp.status == 200:
                    self.activity = await resp.json()
                    return self.activity
        except Exception as e:
            logger.error(f"Failed to fetch activity: {e}")
        return []
    
    async def get_health_check(self) -> bool:
        """Check if OpenProphet API is responding"""
        try:
            async with self.session.get(f"{self.base_url}/health") as resp:
                return resp.status == 200
        except Exception:
            return False
    
    def format_balance_info(self) -> str:
        """Format account balance information"""
        if not self.account_data:
            return "❌ No account data"
        
        balance = self.account_data.get('balance', {})
        if not balance:
            return "❌ No balance info"
        
        total = float(balance.get('total', 0))
        available = float(balance.get('available', 0))
        held = float(balance.get('held', 0))
        
        return f"""
💰 Account Balance:
  Total: ${total:,.2f}
  Available: ${available:,.2f} 
  Held: ${held:,.2f}
"""
    
    def format_positions_info(self) -> str:
        """Format positions information"""
        if not self.positions:
            return "📊 No open positions"
        
        output = ["📊 Open Positions:"]
        for pos in self.positions:
            symbol = pos.get('symbol', 'Unknown')
            size = float(pos.get('size', 0))
            value = float(pos.get('value', 0))
            pnl = float(pos.get('unrealized_pnl', 0))
            pnl_pct = float(pos.get('unrealized_pnl_percent', 0))
            
            status = "🟢" if pnl >= 0 else "🔴"
            output.append(f"  {status} {symbol}: {size:,.4f} (${value:,.2f}) | PnL: ${pnl:,.2f} ({pnl_pct:+.2f}%)")
        
        return "\n".join(output)
    
    def format_activity_info(self) -> str:
        """Format recent activity"""
        if not self.activity:
            return "📈 No recent activity"
        
        output = ["📈 Recent Activity:"]
        for activity in self.activity[-5:]:  # Last 5 activities
            timestamp = activity.get('timestamp', '')
            action = activity.get('action', '')
            symbol = activity.get('symbol', '')
            amount = activity.get('amount', 0)
            price = activity.get('price', 0)
            
            if timestamp:
                try:
                    dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                    time_str = dt.strftime("%H:%M:%S")
                except:
                    time_str = timestamp[:8]
            else:
                time_str = "Unknown"
            
            output.append(f"  {time_str} | {action} {symbol} | {amount:,.4f} @ ${price:,.2f}")
        
        return "\n".join(output)
    
    def print_dashboard(self):
        """Print the trading dashboard"""
        print("\n" + "="*60)
        print(f"🚀 Prophet Trading Dashboard - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print("="*60)
        
        print(self.format_balance_info())
        print(self.format_positions_info())
        print(self.format_activity_info())
        print("\n" + "="*60)
    
    async def run_monitoring_loop(self, interval: int = 30):
        """Run the monitoring dashboard"""
        logger.info(f"Starting Prophet Dashboard monitoring (interval: {interval}s)")
        
        while True:
            try:
                # Check health first
                is_healthy = await self.get_health_check()
                if not is_healthy:
                    print("\n❌ OpenProphet API is not responding!")
                    await asyncio.sleep(interval)
                    continue
                
                # Fetch all data
                await asyncio.gather(
                    self.fetch_account_data(),
                    self.fetch_positions(),
                    self.fetch_activity()
                )
                
                # Display dashboard
                self.print_dashboard()
                
                await asyncio.sleep(interval)
                
            except KeyboardInterrupt:
                logger.info("Dashboard monitoring stopped")
                break
            except Exception as e:
                logger.error(f"Error in monitoring loop: {e}")
                await asyncio.sleep(interval)

async def main():
    """Main dashboard runner"""
    async with ProphetDashboard() as dashboard:
        await dashboard.run_monitoring_loop(interval=30)

if __name__ == "__main__":
    asyncio.run(main())