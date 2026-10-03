# Usage Examples

Examples use synthetic entities and no live household information.

## Safe discovery

“Which lights are on? Include lamps represented as switches.”
“Show the devices and authorized entities in the bedroom.”

## One explicit command

“Turn off the reading lamp and verify its state.”
Discover the actual entity first; never invent an entity ID from its name.

## Several devices and parameters

“Set the bedroom and living-room air conditioners to cool at 25°C.”
Read each capability and service contract. Use one explicit entity array for compatible calls and an ordered batch for related settings.

## Evidence-based analysis

“Compare this appliance's recorded daily kWh over these dates and inspect its allowed automation.”
Check history bounds, missing points and sampling; never conclude from one power spike.

## Asynchronous operations

“Run this reviewed automation and check whether it finished.”
Queued/accepted is not completed; poll status when useful instead of blindly repeating a call.

## Administration

“Check the Home Assistant configuration.”
Only explicitly enabled, discovered admin actions are supported. Maintenance and broad scripts require deliberate review.

[New workflow illustrations](https://github.com/aferende/ha-chatgpt-gateway#illustrative-workflows)
