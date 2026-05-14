import FlowGraph from './FlowGraph'

function App() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
      }}
    >
      <FlowGraph />
    </div>
  )
}

export default App
